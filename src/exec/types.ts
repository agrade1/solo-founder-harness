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
 * system/init의 mcp_servers 항목을 정규화한 상태 (M3a preflight).
 * connected는 status가 정확히 "connected"일 때만 true — pending/failed/needs-auth는 미연결로 본다.
 */
export interface McpServerStatus {
  name: string;
  status: string;
  connected: boolean;
}

/**
 * 정규화된 세션 이벤트. RECON §3 이벤트 타입을 오케스트레이터 관심사로 매핑.
 * 모든 변형은 원본 접근용 `raw`를 들고 있다.
 */
export type SessionEvent =
  | { kind: "init"; sessionId: string; model: string; cwd: string; permissionMode: string; tools: string[]; mcpServers: McpServerStatus[]; raw: RawEvent }
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
  task?: string; // 이번 세션이 완수할 구체 작업 (PromptCompiler 헌법 첫머리)
  inputs?: string[]; // 참고 문서 경로 (projectRoot 상대). API_CONTRACT는 인라인, 나머지는 경로+Read (§3.1.1)
  contractPaths?: string[]; // inputs 중 전문 인라인할 계약 문서 (미지정 시 basename에 API_CONTRACT 포함분 자동)
  dod?: string[]; // Definition of Done — 완료 기준(테스트 포함, ARCH §4.1 L2)
  model?: string; // --model (기본 정책 B: opus). 미지정 시 provider 기본
  fallbackModel?: string; // --fallback-model (강등 사다리 CLI 자동 폴백)
  cwd: string; // 세션 작업 디렉토리 (worktree). 절대경로
  ownership?: string[]; // 담당 경로 glob (ARCH §2 충돌 예방 경계). 권한 컴파일러/향후 훅이 참조
  forbidden?: string[]; // 금지 행동 서술 (예: "API_CONTRACT 변경"). 프롬프트/리뷰 참조
  allowedTools?: string[]; // spec-레벨 추가 허용 (권한 컴파일러 결과에 합쳐짐)
  disallowedTools?: string[]; // spec-레벨 추가 거부
  addDirs?: string[]; // --add-dir (worktree 밖 읽기 허용 경로)
  permissionMode?: string; // --permission-mode (기본 acceptEdits)
  settingsPath?: string; // --settings 파일 경로 (권한 컴파일 결과를 materialize한 것)
  budget?: { maxTurns?: number }; // max_turns = 오케스트레이터가 assistant 이벤트로 강제 (CLI 플래그 아님, RECON §2.1)
  codex?: CodexSessionOptions; // CodexCliProvider 전용 (M5a). 다른 provider는 무시한다
}

/**
 * Codex CLI 전용 실행 옵션 (V3 M5a). 다른 provider는 이 필드를 무시한다.
 * 로드맵 §7.1의 리뷰 계약: **읽기 전용 sandbox** · xhigh · fresh/ephemeral 세션.
 *
 * **`workspace-write`는 M5a에서 hard deny다**(2026-07-27 fresh Codex 리뷰 P0/A).
 * Codex는 planner/reviewer이며 read-only다. 쓰기 모드는 manifest의 task 소유권·writableRoots를
 * 실제로 집행하는 **task-bound 권한 계층이 생긴 뒤에만** 별도 승인으로 되살린다. bypass 계열 sandbox는 없다.
 */
export interface CodexSessionOptions {
  reasoningEffort?: "low" | "medium" | "high" | "xhigh"; // 기본 xhigh
  /** M5a에서 유일하게 허용되는 값. 다른 값은 `codex_sandbox_forbidden`으로 거부된다. */
  sandbox?: "read-only";
  /** `--output-schema` 파일 절대경로 (구조화 최종 출력이 필요할 때만). */
  outputSchemaPath?: string;
  /**
   * provider 전용 격리 codex 설정 홈 **절대·정규 경로**(비-symlink 디렉터리 · 0700 · 사용자 홈 아님).
   * **필수**이며 사용자 전역 설정·MCP·자격증명 상속을 막는 지점이다(auth 복사·영속화 없음).
   *
   * 수명은 **provider 소유**다: **첫 invocation에서는 비어 있어야 하고**(ambient config·auth·MCP 0),
   * 그때 고정된 **디렉터리 신원(dev+ino)** 이 소유권이 된다. **이후 invocation(resume)은 같은 신원의
   * 같은 홈**이어야 하며 그때는 codex가 남긴 세션 상태가 있는 것이 정상이다 — 교체·symlink화·권한 완화·
   * provider가 소유하지 않은 기존 상태는 프로세스를 띄우지 않는다.
   */
  codexHome: string;
  /** 기본 true(`--ephemeral`). resume이 필요한 세션만 false로 시작한다. */
  ephemeral?: boolean;
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
