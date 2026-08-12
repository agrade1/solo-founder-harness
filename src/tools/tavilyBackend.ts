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

export interface TavilyOptions {
  /** 검색 1회가 돌려줄 후보 수(§6.3: 4~8건). */
  maxResults?: number;
  timeoutMs?: number;
}

/**
 * 환경변수 `TAVILY_API_KEY`에서 key를 읽어 backend를 만든다. 없으면 **호출 전에** fail-closed다
 * (키 없이 조용히 빈 결과를 돌려주면 그것이 곧 거짓 근거다).
 */
export function createTavilyBackend(opts: TavilyOptions = {}): ResearchBackend {
  const apiKey = process.env.TAVILY_API_KEY;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new TavilyError("secret_missing", "TAVILY_API_KEY 환경변수가 없다 — 검색 backend를 만들 수 없다");
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
