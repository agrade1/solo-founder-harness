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

/** 종료 결과 소비자가 쓰는 안정 오류 코드 5개(호출자별로 다르므로 명시 입력이다). */
export interface TerminalCodes {
  /** 이벤트 수가 상한을 넘었다. */
  unbounded: string;
  /** 스트림 소비가 provider 밖의 이유로 터졌다. */
  streamFailed: string;
  /** 종료 결과가 하나도 없다. */
  noResult: string;
  /** 종료 결과가 실패다(`isError`). */
  resultError: string;
  /** 종료 결과가 둘 이상이거나 종료 뒤에 이벤트가 더 왔다. */
  duplicate: string;
}

/**
 * **한 invocation의 스트림에서 종료 결과를 정확히 하나만 받는다**(V3 M5b — 독립 리뷰 A5 · 대장 `B-8`).
 *
 * 이전 판의 소비자들(`reviewer.ts` · `StableController`)은 `if (e.kind === "result") result = e`로
 * **마지막 종료 결과가 앞의 것을 덮었다** → 실패 종료 뒤에 성공 종료가 오면 성공으로 읽혔다.
 * 여기서는 ⓐ 종료 결과 뒤의 **모든** 이벤트(두 번째 종료 결과 포함)를 거부하고 ⓑ 종료 결과가 없으면
 * 거부하고 ⓒ `isError`면 거부한다. 소비자가 다르므로 코드만 호출자가 준다(로직은 하나다).
 *
 * **오류 코드 taxonomy는 닫혀 있다(2차 리비전 A5b).** 이전 판은 "문자열 `code`를 가진 Error"면 무엇이든
 * 그대로 통과시켰으므로, provider iterator가 `code = "result_accepted"` 같은 **오케스트레이션 결과 코드**를
 * 달아 던지는 것만으로 실패 outcome에 성공처럼 보이는 marker를 심을 수 있었다. 이제 이 함수가 **자기가
 * 만든 오류만** 통과시키고(참조 동일성) 나머지는 전부 `codes.streamFailed`로 접는다 —
 * provider는 자기 실패의 **분류를 고를 수 없다**(transcript·경로도 오류에 싣지 않는다).
 * 오류 생성은 **호출자가 준 factory**(`makeError`)로 한다: 호출자는 그 factory 안에서 자기 모듈의
 * **사설 provenance**를 붙일 수 있으므로, 공개 클래스 `instanceof`가 아니라 "누가 만들었는가"로
 * 판정할 수 있다(3차 리비전 A2).
 *
 * `onTerminal`은 **종료 결과를 처음 본 그 자리에서 · 성공/실패를 해석하기 전에** 정확히 한 번 불린다.
 * 실패한 turn이 태운 토큰도 예산에서 빠지게 하는 지점이다. **스트림이 끝날 때까지 미루지 않는 이유**
 * (3차 리비전 B): 종료 뒤에 늦은 이벤트·두 번째 종료가 오거나 iterator가 그때 던지면 `duplicate`/
 * `streamFailed`로 닫히는데, 이전 판은 그 경로에서 `onTerminal`을 **한 번도 부르지 않아** 이미 태운
 * 첫 종료의 usage가 전역 예산에서 빠지지 않았다. 여기서 던지는 오류(예산 소진 등)는 호출자 것이므로
 * 그대로 올라간다.
 */
export async function consumeExactlyOneTerminal(
  stream: AsyncIterable<SessionEvent>,
  codes: TerminalCodes,
  maxEvents: number,
  makeError: (code: string, message: string) => Error & { code: string },
  onTerminal?: (result: Extract<SessionEvent, { kind: "result" }>) => void,
): Promise<Extract<SessionEvent, { kind: "result" }>> {
  let result: Extract<SessionEvent, { kind: "result" }> | null = null;
  let seen = 0;
  /**
   * **그대로 올려보낼 오류**: 이 함수가 직접 만든 것 또는 `onTerminal`(호출자 코드)이 던진 것.
   * 참조 동일성으로만 판정한다 — 흉내낸 코드·이름은 통과하지 못한다.
   * `null` 초기값을 쓰지 않는 이유: provider가 `throw null`을 하면 `err === mine`이 참이 된다.
   */
  let mine: unknown;
  const own = (code: string, message: string): Error => {
    const e = makeError(code, message);
    mine = e;
    return e;
  };
  try {
    for await (const e of stream) {
      if (++seen > maxEvents) throw own(codes.unbounded, "스트림이 이벤트 상한을 넘었다");
      // 종료 뒤에는 아무 것도 오지 않는다 — 두 번째 종료 결과도, 늦은 assistant·status도 거부다.
      if (result) throw own(codes.duplicate, "종료 결과 뒤에 이벤트가 더 왔다(종료는 정확히 1건이다)");
      if (e.kind === "result") {
        result = e;
        // 회계는 **여기서 정확히 한 번**이다(위 `if (result)` 가드가 두 번째 진입을 막는다).
        try {
          onTerminal?.(e);
        } catch (err) {
          mine = err; // 호출자(예산 게이트) 오류는 접지 않고 그대로 올린다
          throw err;
        }
      }
    }
  } catch (err) {
    if (mine !== undefined && err === mine) throw err;
    throw makeError(codes.streamFailed, "스트림 소비가 실패했다");
  }
  if (!result) throw makeError(codes.noResult, "이 스트림에 종료 결과가 없다");
  if (result.isError) {
    throw makeError(codes.resultError, `turn이 실패로 끝났다(${result.terminalReason ?? "unknown"})`);
  }
  return result;
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
  /**
   * provider가 발급한 **불투명 세션 신원**(선택 · V3 M5a 5차 리비전).
   *
   * `sessionId`만으로는 **같은 id로 만들어진 교체 세션**과 낡은 핸들을 구별할 수 없다 —
   * 세션을 stop한 뒤 같은 id로 다시 start하면 예전 핸들이 새 세션의 이벤트를 읽거나 거기에
   * 지시를 보내거나 그것을 중지할 수 있었다. 그래서 provider는 **세션 인스턴스 1개당 하나의
   * 신원 객체**를 만들어 자기가 발급한 핸들에 붙이고, 이후 호출에서 **참조 동일성**으로만 대조한다.
   *
   * 값은 **내용이 없는 frozen 객체**다 — 비밀·난수 material이 아니므로 직렬화·로그·문서에 새어도
   * 잃을 것이 없고(빈 객체로 보인다), 반대로 그 참조를 **이미 가진 쪽**만 그 세션을 조종할 수 있다.
   * 이 필드를 쓰지 않는 provider(`claude-cli`·`mock-exec`)는 그대로 동작한다(하위 호환).
   */
  readonly providerBinding?: object;
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
