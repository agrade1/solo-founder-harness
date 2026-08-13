const SEARCH_URL = "https://api.tavily.com/search";
const EXTRACT_URL = "https://api.tavily.com/extract";
export class TavilyError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "TavilyError";
        this.code = code;
    }
}
/** 응답 1건에서 우리가 쓰는 필드만 좁게 읽는다(미상 필드는 버린다). */
function pick(o, urlKey, textKey) {
    if (typeof o !== "object" || o === null)
        return null;
    const r = o;
    const source = r[urlKey];
    const raw = r[textKey];
    if (typeof source !== "string" || typeof raw !== "string" || raw.length === 0)
        return null;
    return { source, title: typeof r.title === "string" ? r.title : source, raw };
}
async function post(url, apiKey, body, timeoutMs) {
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
    }
    catch (e) {
        if (e instanceof TavilyError)
            throw e;
        throw new TavilyError("backend_unreachable", `Tavily 호출 실패: ${e.name}`);
    }
    finally {
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
    "셸에서 직접 설정한다:",
    `  export ${TAVILY_SECRET_REF}=<발급받은 키>            # 이 셸에서만`,
    `  echo 'export ${TAVILY_SECRET_REF}=<키>' >> ~/.zshrc  # 영구`,
    "무료 키: https://tavily.com (1,000 크레딧/월 · 카드 불요)",
    "설정한 뒤 같은 명령을 다시 실행하라.",
].join("\n");
/**
 * 키가 있는지만 본다(값은 돌려주지 않는다). **LLM 왕복을 태우기 전에** 부르는 용도다 —
 * 1차 실행에 토큰을 쓰고 나서 검색 단계에서 실패하면 그 비용이 그냥 버려진다.
 */
export function researchSecretAvailable() {
    const v = process.env[TAVILY_SECRET_REF];
    return typeof v === "string" && v.length > 0;
}
/**
 * 환경변수 `TAVILY_API_KEY`에서 key를 읽어 backend를 만든다. 없으면 **호출 전에** fail-closed다
 * (키 없이 조용히 빈 결과를 돌려주면 그것이 곧 거짓 근거다).
 */
export function createTavilyBackend(opts = {}) {
    const apiKey = process.env[TAVILY_SECRET_REF];
    if (typeof apiKey !== "string" || apiKey.length === 0) {
        throw new TavilyError("secret_missing", TAVILY_SETUP_HINT);
    }
    const maxResults = opts.maxResults ?? 5;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    return {
        async search(query) {
            const json = await post(SEARCH_URL, apiKey, { query, max_results: maxResults, search_depth: "basic", include_raw_content: false }, timeoutMs);
            const results = json?.results;
            if (!Array.isArray(results))
                throw new TavilyError("backend_malformed", "Tavily search 응답에 results 배열이 없다");
            return results.map((r) => pick(r, "url", "content")).filter((r) => r !== null);
        },
        async extract(url) {
            const json = await post(EXTRACT_URL, apiKey, { urls: [url], extract_depth: "basic" }, timeoutMs);
            const results = json?.results;
            const first = Array.isArray(results) ? pick(results[0], "url", "raw_content") : null;
            if (first === null)
                throw new TavilyError("backend_malformed", `Tavily extract가 본문을 돌려주지 않았다: ${url}`);
            return first;
        },
    };
}
