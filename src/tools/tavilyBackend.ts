/**
 * V3 M7 T7 — Tavily 검색 backend(`ResearchBackend` 구현 1개).
 *
 * **backend는 하나만 노출한다**(설계 정본 §6.3 — Tavily/Firecrawl 동시 노출 금지).
 * secret은 **환경변수에서만** 읽는다: URL·config·trace·오류 메시지에 값을 싣지 않는다(§7).
 * 상한·캐시·도메인 게이트는 여기 없다 — `researchGateway.runResearch`가 이미 집행한다(중복 금지).
 */
import type { BackendResult, ResearchBackend } from "./researchGateway.js";

const SEARCH_URL = "https://api.tavily.com/search";
const EXTRACT_URL = "https://api.tavily.com/extract";

export class TavilyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TavilyError";
    this.code = code;
  }
}

/** 응답 1건에서 우리가 쓰는 필드만 좁게 읽는다(미상 필드는 버린다). */
function pick(o: unknown, urlKey: string, textKey: string): BackendResult | null {
  if (typeof o !== "object" || o === null) return null;
  const r = o as Record<string, unknown>;
  const source = r[urlKey];
  const raw = r[textKey];
  if (typeof source !== "string" || typeof raw !== "string" || raw.length === 0) return null;
  return { source, title: typeof r.title === "string" ? r.title : source, raw };
}

async function post(url: string, apiKey: string, body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      // key는 헤더로만 간다 — query string에 넣으면 로그·프록시에 남는다.
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) {
      // 본문을 그대로 싣지 않는다(요청 echo에 key가 섞여 나오는 백엔드가 있다).
      throw new TavilyError("backend_http_error", `Tavily 응답 상태 ${res.status}`);
    }
    return await res.json();
  } catch (e) {
    if (e instanceof TavilyError) throw e;
    throw new TavilyError("backend_unreachable", `Tavily 호출 실패: ${(e as Error).name}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 환경변수 이름 정본 — registry profile `research-tavily`의 `secretRefs`와 같아야 한다. */
export const TAVILY_SECRET_REF = "TAVILY_API_KEY";

/**
 * **사용자에게 값을 요구하지 않는다.** 키가 없을 때 내보내는 안내다 — 값을 프롬프트·채팅에 넣게 하면
 * 그 순간 secret이 모델 컨텍스트와 대화 기록으로 들어간다. 사용자는 자기 셸에만 넣고, 하네스는
 * 부모 프로세스에서 env로만 읽는다(자식 세션에는 전달하지 않는다).
 */
export const TAVILY_SETUP_HINT = [
  `${TAVILY_SECRET_REF}가 설정돼 있지 않다. **키 값을 프롬프트나 채팅에 붙여넣지 마라.**`,
  "둘 중 하나로 넣는다:",
  `  ① 하네스가 만들어 둔 workspace 루트의 .env 파일에서 \`${TAVILY_SECRET_REF}=\` 뒤에 값만 채운다 (권장 · 0600)`,
  `  ② 셸에서 직접: export ${TAVILY_SECRET_REF}=<발급받은 키>`,
  "무료 키: https://tavily.com (실측 필요 — 크레딧·플랜 과금은 계정마다 다르다)",
  "설정한 뒤 같은 명령을 다시 실행하라. 키가 없으면 자체 리서치(self)로 진행한다.",
].join("\n");

/**
 * 키가 있는지만 본다(값은 돌려주지 않는다). **LLM 왕복을 태우기 전에** 부르는 용도다 —
 * 1차 실행에 토큰을 쓰고 나서 검색 단계에서 실패하면 그 비용이 그냥 버려진다.
 */
export function researchSecretAvailable(): boolean {
  const v = process.env[TAVILY_SECRET_REF];
  return typeof v === "string" && v.length > 0;
}

export interface TavilyOptions {
  /** 검색 1회가 돌려줄 후보 수(§6.3: 4~8건). */
  maxResults?: number;
  timeoutMs?: number;
  /**
   * [C-126] 키를 **인자로** 받는다. `.env` 리더(`core/envFile.ts`)가 해석한 값이 여기로만 흐르고
   * `process.env`에는 실리지 않는다 — 자식 프로세스(claude-code/exec/mission/handoff)는 부모 env를
   * 상속하므로, env에 넣는 순간 키가 모델 세션으로 들어간다.
   * 미지정 시에만 `process.env[TAVILY_API_KEY]`로 강하한다(기존 스크립트 호출부 보존).
   */
  apiKey?: string;
}

/**
 * key로 backend를 만든다(`opts.apiKey` → 없으면 `process.env.TAVILY_API_KEY`). 없으면 **호출 전에**
 * fail-closed다 (키 없이 조용히 빈 결과를 돌려주면 그것이 곧 거짓 근거다).
 */
export function createTavilyBackend(opts: TavilyOptions = {}): ResearchBackend {
  const apiKey = opts.apiKey ?? process.env[TAVILY_SECRET_REF];
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new TavilyError("secret_missing", TAVILY_SETUP_HINT);
  }
  const maxResults = opts.maxResults ?? 5;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return {
    async search(query: string): Promise<BackendResult[]> {
      const json = await post(
        SEARCH_URL,
        apiKey,
        { query, max_results: maxResults, search_depth: "basic", include_raw_content: false },
        timeoutMs,
      );
      const results = (json as { results?: unknown })?.results;
      if (!Array.isArray(results)) throw new TavilyError("backend_malformed", "Tavily search 응답에 results 배열이 없다");
      return results.map((r) => pick(r, "url", "content")).filter((r): r is BackendResult => r !== null);
    },
    async extract(url: string): Promise<BackendResult> {
      const json = await post(EXTRACT_URL, apiKey, { urls: [url], extract_depth: "basic" }, timeoutMs);
      const results = (json as { results?: unknown })?.results;
      const first = Array.isArray(results) ? pick(results[0], "url", "raw_content") : null;
      if (first === null) throw new TavilyError("backend_malformed", `Tavily extract가 본문을 돌려주지 않았다: ${url}`);
      return first;
    },
  };
}
