/**
 * [C-126] 리서치 런타임 — **`runRun`과 파이프라인 `nextLocked`가 공유하는 한 함수**(설계 §4.1 A-1).
 *
 * 왜 공유인가: 파이프라인은 `commands/run.ts`를 거치지 않는다 — `nextLocked`가
 * `locked.runStage(...) → runWorkflow(...)`를 직접 부른다. 키 해석을 `run.ts`에만 두면
 * `pipeline next`의 1단계(idea-validation)는 **항상 self**가 되고, 이 슬라이스의 목적이 죽는다.
 * 그래서 판정은 여기 하나이고 호출자가 둘이다.
 *
 * 함께 사는 것들(전부 순수 함수 + 파일 쓰기 하나): 선언 파서 · evidence digest 예산 · run 수명
 * sessionBackend · attempt receipt writer. `runWorkflow`는 이 조각들을 **조립만** 한다.
 *
 * ## 미확인 (설계 §10 — 다음 사람이 닫힌 것으로 믿지 않게)
 *
 * - Tavily 스펙(endpoint·응답 형태·크레딧 단가·플랜 과금·rate limit)은 **live 1회 실측 전 미확정**이다.
 * - live 모델의 선언/`none` 준수율은 표본이 없다(불이행 = fail closed → 마찰 가능).
 * - 최악 프롬프트 ≈64KB(seed 16KB + digest 16KB + 1차 전문 32KB)를 provider가 감당하는지 미실측.
 * - 이 리더는 **CLI 경로(run·pipeline)에서만** 돈다. 스크립트 직접 실행은 기존 셸 env 방식이다.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveResearchKey } from "./envFile.js";
import { redactSecrets } from "../tools/redact.js";
import { createTavilyBackend } from "../tools/tavilyBackend.js";
import { MAX_BACKEND_CALLS_PER_RUN, ResearchError, parseResearchRequests, renderEvidenceDigest, } from "../tools/researchGateway.js";
// ── 상한 (설계 §6.2·§6.3) ───────────────────────────────────────
/** evidence digest 총 byte 상한. **byte다**(코드포인트 아님 — 다국어에서 chars ≠ bytes). */
export const EVIDENCE_DIGEST_MAX_BYTES = 16_384;
/** 2차에 싣는 1차 문서 전문의 byte 상한. 초과는 **자르지 않고** fail closed. */
export const RESEARCH_FIRST_PASS_MAX_BYTES = 32_768;
/** run_state에 남기는 attempt 수 상한(코드가 실제로 집행한다). 장기 보존은 receipt 파일이 담당. */
export const RESEARCH_MAX_ATTEMPTS = 4;
/** 1차 문서가 낼 수 있는 선언 수 상한 — 설계 §4.2의 "최대 2줄". */
export const RESEARCH_MAX_DECLARATIONS = 2;
/** run 1회가 저장할 evidence 총 건수 상한. */
export const RESEARCH_MAX_EVIDENCE_PER_RUN = 12;
/** backend 1회 호출이 돌려줄 수 있는 결과 수 상한. */
export const RESEARCH_MAX_RESULTS_PER_CALL = 8;
/** source URL 길이 상한(§A-8). */
export const RESEARCH_MAX_URL_CHARS = 2048;
/** 영수증에 남기는 redacted query 길이 상한. */
export const REDACTED_QUERY_MAX_CHARS = 100;
/**
 * evidence digest를 **받는 agent 목록**(상수 allowlist · B-1). 이 목록 밖의 agent는 받지 않는다 —
 * 특히 critic은 편향 분리(`conclusion_only`)가 존재 이유라서, 근거를 주면 그 격리가 깨진다.
 */
export const EVIDENCE_DIGEST_RECIPIENTS = ["pm", "red_team", "founder_ceo"];
/**
 * 키를 해석해 runtime을 만든다. 키가 있으면 external, 없으면 self다.
 *
 * `.env` 템플릿 생성은 `resolveResearchKey` → `ensureEnvFileReady`가 **git 안전 검사를 통과한 뒤에만**
 * 한다(A-5). 예전엔 이 함수가 검사 밖에서 따로 만들었고, 그러면 새 `.env`가 unignored로 남을 수 있었다.
 */
export function resolveResearchRuntime(opts = {}) {
    const r = resolveResearchKey(opts);
    if (r.key === null) {
        const notices = [...r.notices];
        if (r.created) {
            notices.push(`리서치 키 파일을 만들었습니다: ${r.envPath} (값만 채우면 다음 실행부터 외부 검색을 씁니다)`);
        }
        if (r.skippedLines > 0) {
            // 내용·이름은 적지 않는다 — 개수만. "왜 내 키를 못 읽나"의 유일한 단서이면서 유출이 아니다.
            notices.push(`(${r.envPath}에서 대상이 아닌 줄 ${r.skippedLines}개는 읽지 않았습니다 — 하네스는 TAVILY_API_KEY 한 이름만 읽습니다)`);
        }
        return { kind: "self", envPath: r.envPath, notices };
    }
    const key = r.key;
    return {
        kind: "external",
        // 키는 **인자로만** 흐른다 — `process.env`에 넣지 않는다(자식 프로세스 상속 차단).
        backend: createTavilyBackend({ apiKey: key, maxResults: opts.maxResults }),
        scrub: (s) => redactSecrets(s, [key]),
    };
}
/**
 * [C-126/A-6] **실행 전 설정 상태** 한 줄. run이 시작되기 전에 아는 것은 "키가 설정됐다"뿐이고
 * **실제 mode가 아니다** — research step이 없는 workflow도, 모델이 `none`을 낸 실행도, 결과 0건도,
 * 실패도 모두 이 시점에는 구분되지 않는다. 그래서 문구가 "사용 **가능**(설정됨)"이다.
 * 실제 mode는 run이 끝난 뒤 `researchOutcomeLines()`가 영수증에서 읽어 출력한다.
 */
export function researchModeLines(rt) {
    if (rt.kind === "external") {
        return [`리서치: 외부 검색(Tavily) 사용 **가능** (키 설정됨) — 실제 사용 여부는 실행 후 영수증에 적힙니다. 근거는 ${RESEARCH_DIR_REL}/에 저장됩니다.`];
    }
    return [`리서치: 외부 검색 키 없음 — 자체(self)로 진행합니다. 쓰려면 이 파일에 값만 채우세요: ${rt.envPath}`, ...rt.notices];
}
/**
 * [C-126/A-6] **실행 후 실제 mode 영수증.** `run`과 `pipeline next`가 같은 함수를 쓴다 — 렌더가 두
 * 벌이면 한쪽만 정직해진다(B-40의 `gateOutcomeLabel`이 잡은 부류). attempt가 없으면 빈 배열이다
 * (리서치 step이 없는 workflow에서 리서치 이야기를 하지 않는다).
 */
export function researchOutcomeLines(attempts) {
    const a = attempts?.at(-1);
    if (!a)
        return [];
    const tail = ` · 영수증 ${a.receipt_path || "(미기록)"}`;
    switch (a.mode) {
        case "external":
            return [`리서치 결과: 외부 검색 사용 — 근거 ${a.evidence.length}건 (backend ${a.backend_calls}회 · 캐시 ${a.cache_hits}회)${tail}`];
        case "external_declined":
            return [`리서치 결과: 모델이 '검색 불필요'를 선언 — 외부 호출 0회${tail}`];
        case "external_empty":
            return [`리서치 결과: 외부 검색 결과 0건 (backend ${a.backend_calls}회) — 근거 없이 1차 판단을 채택했습니다${tail}`];
        case "self":
            return [`리서치 결과: 자체(self) — 외부 검색을 쓰지 않았습니다${tail}`];
        default:
            return [`리서치 결과: 중단 (${a.error_code ?? "사유 미기록"}) — 저장된 근거 ${a.evidence.length}건${tail}`];
    }
}
// ── 1차 선언 파싱 ───────────────────────────────────────────────
/** `RESEARCH_REQUEST none` — "검색이 필요 없다"는 **명시 종결자**. 무선언은 이것과 다르다. */
const NONE_LINE = "RESEARCH_REQUEST none";
const DECL_LINE_RE = /^RESEARCH_REQUEST\s+(.+)$/;
/**
 * 1차 문서 말미의 선언을 읽는다. **닫힌 형태**이고 그 밖의 무엇도 요청이 되지 않는다.
 *
 * `missing`이 `none`과 갈리는 이유(§9-11 기각 대안): 무선언을 조용히 self로 접으면 "모델이 지시를
 * 무시했다"와 "모델이 검색이 불필요하다고 판단했다"가 같은 영수증을 받는다. 종결자를 요구하면
 * 전자는 fail closed다(마찰은 감수한다 — 거짓 영수증보다 낫다).
 */
export function parseResearchDeclaration(document) {
    const lines = document.split("\n").map((l) => l.trim());
    const decl = lines.filter((l) => DECL_LINE_RE.test(l));
    if (decl.length === 0)
        return { kind: "missing" };
    const nones = decl.filter((l) => l === NONE_LINE);
    if (nones.length > 0) {
        if (decl.length !== nones.length) {
            return { kind: "invalid", detail: `'${NONE_LINE}'와 검색 선언이 함께 있다 (판정 불가 — 하나만 내라)` };
        }
        return { kind: "none" };
    }
    if (decl.length > RESEARCH_MAX_DECLARATIONS) {
        return { kind: "invalid", detail: `선언은 최대 ${RESEARCH_MAX_DECLARATIONS}줄이다 (실제 ${decl.length}줄)` };
    }
    let requests;
    try {
        requests = parseResearchRequests(decl.join("\n"));
    }
    catch (e) {
        return { kind: "invalid", detail: e instanceof ResearchError ? e.message : e.message };
    }
    // extract는 **봉인**이다(§5.4 · allowedDomains:null이 gateway에서도 전부 거부한다).
    // 여기서 먼저 거부하는 이유: 그 선언이 온 것 자체가 계약 위반이고, 사유 코드가 달라야 한다
    // (`domain_not_allowed`는 "도메인 문제"로 읽히지만 실제 사실은 "extract는 열려 있지 않다"다).
    const bad = requests.find((r) => r.type !== "search");
    if (bad)
        return { kind: "invalid", detail: `type=extract는 허용되지 않는다 (search만 · 원문 수집은 봉인)` };
    if (requests.length === 0)
        return { kind: "invalid", detail: "선언 줄이 있는데 요청이 하나도 파싱되지 않았다" };
    return { kind: "requests", requests };
}
/** 1차 프롬프트에 주입하는 선언 지시. 키가 있을 때만 실린다(없으면 프롬프트 바이트 불변). */
export const RESEARCH_DECLARATION_INSTRUCTION = [
    "이 판단에 **외부 검색**이 필요하면, 문서 **맨 끝**에 아래 형식으로 최대 " +
        `${RESEARCH_MAX_DECLARATIONS}줄까지 선언하라 (하네스가 대신 검색해 2차에 근거를 준다):`,
    '  RESEARCH_REQUEST query="<검색어>" | type=search',
    "검색이 필요 없으면 **정확히** 다음 한 줄만 내라:",
    `  ${NONE_LINE}`,
    "",
    "규칙 (어기면 실행이 멈춘다):",
    `- \`type=search\`만 허용된다. \`type=extract\`(원문 수집)는 봉인돼 있다.`,
    "- query는 큰따옴표로 감싼 1~200자 한 줄이다.",
    "- 선언도 `none`도 없으면 하네스가 판정할 수 없어 **중단한다**.",
    "- **고지: 이 검색어는 외부 검색 서비스(Tavily)로 전송된다.** 비공개 정보·자격증명·개인정보를 넣지 마라.",
].join("\n");
/** 2차(근거 반영) 요청문. 1차 전문과 그 sha256을 함께 실어 "무엇을 고치는가"를 못 박는다. */
export function secondPassRequest(firstPass, firstPassSha256) {
    return [
        "아래는 **네가 직전에 낸 1차 판단 전문**이다 (sha256: " + firstPassSha256 + ").",
        "위 프롬프트의 근거 블록(수집된 데이터)을 반영해 이 판단을 **수정한 문서 전체**를 다시 출력하라.",
        "",
        "- 근거를 인용할 때는 그 항목의 `source`와 `sha256`을 함께 적어라.",
        "- 그 sha256은 **하네스가 저장한 검색 응답 바이트**의 해시다 — 웹 페이지 원문을 검증한 것이 아니다.",
        "  근거가 스니펫 수준이라는 사실을 Assumptions에 남겨라.",
        "- 근거와 어긋나는 1차 주장은 고치거나 왜 유지하는지 적어라.",
        `- \`RESEARCH_REQUEST\` 선언은 더 내지 마라 (이 run의 검색은 끝났다).`,
        "",
        "--- 1차 판단 전문 시작 ---",
        firstPass,
        "--- 1차 판단 전문 끝 ---",
    ].join("\n");
}
/** 영수증에 남길 query — redact 후 상한까지. 값이 길면 잘렸다는 사실을 표시한다. */
export function redactedQuery(query, scrub) {
    const s = scrub(query);
    const chars = [...s];
    return chars.length <= REDACTED_QUERY_MAX_CHARS ? s : `${chars.slice(0, REDACTED_QUERY_MAX_CHARS).join("")}…(절삭)`;
}
/**
 * digest를 렌더하고 **byte 상한을 집행한다**. 초과면 자르지 않고 실패다 —
 * 조용한 절단은 "근거를 다 봤다"는 거짓 전제를 2차에 심는다(§6.3: silent truncation 금지).
 */
export function buildEvidenceDigest(items) {
    const digest = renderEvidenceDigest(items);
    const bytes = Buffer.byteLength(digest, "utf8");
    if (bytes > EVIDENCE_DIGEST_MAX_BYTES)
        return { ok: false, bytes, limit: EVIDENCE_DIGEST_MAX_BYTES };
    return { ok: true, digest, bytes };
}
/**
 * run 수명 동안 backend를 감싼다. 하는 일 넷:
 *
 *  ⓐ **run 누적 호출 상한**(`MAX_BACKEND_CALLS_PER_RUN`) — gateway의 상한은 `runResearch` **1회**
 *     기준이라, 게이트가 research로 되돌리면(idea-validation의 '검증' 판정) 매 attempt마다 8회가
 *     새로 열린다. run 전체를 세는 자리는 여기뿐이다.
 *  ⓑ **attempt 간 query memo** — 같은 질의를 다시 부르지 않는다(재진입 = 무과금).
 *  ⓒ **저장 전 redaction** — backend가 요청을 echo해 키를 되돌려줘도 파일·digest·영수증에 남지 않는다.
 *  ⓓ **결과 수·URL 길이·총 evidence 상한** — fail closed(`research_cap_exceeded`).
 */
export function createSessionBackend(inner, scrub, opts = {}) {
    const memo = new Map();
    let calls = opts.priorCalls ?? 0;
    let memoHits = 0;
    let results = opts.priorResults ?? 0;
    const clean = (r) => {
        if (r.source.length > RESEARCH_MAX_URL_CHARS) {
            throw new ResearchError("research_cap_exceeded", `source URL이 상한 ${RESEARCH_MAX_URL_CHARS}자를 넘는다 (${r.source.length}자)`);
        }
        return { source: scrub(r.source), title: scrub(r.title), raw: scrub(r.raw) };
    };
    const take = (out) => {
        if (out.length > RESEARCH_MAX_RESULTS_PER_CALL) {
            throw new ResearchError("research_cap_exceeded", `backend가 상한 ${RESEARCH_MAX_RESULTS_PER_CALL}건보다 많은 결과를 돌려줬다 (${out.length}건)`);
        }
        if (results + out.length > RESEARCH_MAX_EVIDENCE_PER_RUN) {
            throw new ResearchError("research_cap_exceeded", `run 1회 evidence 상한 ${RESEARCH_MAX_EVIDENCE_PER_RUN}건을 넘는다`);
        }
        results += out.length;
        return out;
    };
    return {
        get calls() {
            return calls;
        },
        get memoHits() {
            return memoHits;
        },
        get results() {
            return results;
        },
        async search(query) {
            const key = `search:${query}`;
            const hit = memo.get(key);
            if (hit) {
                memoHits++;
                return take(hit);
            }
            if (calls >= MAX_BACKEND_CALLS_PER_RUN) {
                throw new ResearchError("research_budget_exceeded", `run 누적 backend 호출이 상한 ${MAX_BACKEND_CALLS_PER_RUN}회를 넘는다`);
            }
            calls++;
            const out = (await inner.search(query)).map(clean);
            memo.set(key, out);
            return take(out);
        },
        async extract() {
            // 도달 불가 경로다(선언 파서가 먼저 거부하고 gateway의 allowedDomains:null이 또 거부한다).
            // 그래도 열어두지 않는다 — 이 함수가 조용히 동작하면 그것이 곧 봉인 우회 통로다.
            throw new ResearchError("research_declaration_invalid", "extract는 봉인돼 있다 (search 전용)");
        },
    };
}
/** `outputs/research` — evidence·raw·receipt·instance log가 모두 여기 산다. */
export const RESEARCH_DIR_REL = "outputs/research";
/**
 * [C-126/B-1] attempt **발생 인스턴스** append-only 로그.
 *
 * content-addressed receipt는 "어떤 사실이었나"를 보존하지만 **몇 번 일어났나**를 잃는다(같은 body면
 * 파일 하나를 공유하고, `run_state`는 다음 workflow가 덮고 `attempts[]`는 4개로 잘린다).
 * 그래서 seal마다 한 줄을 append한다 — audit이 묻는 것은 다중성이고 그 값은 이 한 줄이 답한다.
 *
 * **checkpoint에 결박하지 않는다**(`evidence.jsonl`과 같은 규율): append-only를 결박하면 승인 후
 * 정당한 append 하나가 전수 검증에서 전부 drift가 된다. 권위는 receipt+raw에 있다.
 *
 * ponytail: 파일 한 줄이 가장 싼 형태다. semantic receipt를 instance마다 복제하는 방향은 기각했다 —
 * checkpoint가 결박할 대상이 매 재실행마다 달라져 B-41 불변식 3이 다시 깨진다.
 */
export const RESEARCH_ATTEMPT_LOG_REL = `${RESEARCH_DIR_REL}/attempts.jsonl`;
/**
 * attempt 종결 시 **불변 receipt**를 남긴다(성공·실패 무관).
 *
 * 왜 파일인가: `run_state.json`은 **다음 workflow가 덮는다**(mvp-planning이 idea-validation의
 * run_state를 대체한다 — 실측). 그러면 idea-validation의 리서치 영수증이 소멸하고, 승인자가
 * "이 문서가 어떤 근거에서 나왔나"를 승인 바이트 안에서 볼 길이 없어진다(§9-16 기각 대안).
 *
 * write-once(`wx`)인 이유: 이 파일이 checkpoint에 결박되므로 **승인 후에 바뀔 정당한 경로가 없다.**
 *
 * ## 이름이 **content-addressed**인 이유 (설계와 다르게 구현한 지점 — 근거를 남긴다)
 *
 * 설계 §4.3은 `receipt-<compact started_at>[-n].json`(시각 + 충돌 시 suffix 루프)을 지시했다.
 * 그것을 그대로 쓰면 **B-41 불변식 3을 깬다**: "승인은 바이트 결박이고 run 신원 결박이 아니다 —
 * 같은 workflow를 다시 돌려 완전히 같은 바이트가 나오면 checkpoint_id도 같다." 시각 기반 이름은
 * 재실행마다 `-2`, `-3`으로 갈라지므로 **같은 사실을 낸 재실행이 항상 다른 checkpoint_id**가 되고,
 * `pipeline.test.ts` P4가 그 계약을 정면으로 재고 있다(실측: 재실행에서 id가 갈렸다).
 *
 * content-addressed 이름은 설계가 요구한 성질을 **전부** 지킨다: write-once(`wx`) · 덮어쓰기 없음 ·
 * 승인 후 변경이 drift · 같은 raw 저장 규칙(`evidenceStore`)과 같은 패턴. 그리고 "같은 바이트 →
 * 같은 id"가 살아 있다. 잃는 것 하나: **같은 run 안에서 attempt 두 개의 사실이 완전히 동일하면
 * 같은 파일 하나를 공유한다**(주입된 고정 시각 + memo 적중이 겹칠 때만 — 실제 시계에서는
 * `started_at`이 달라 갈린다). **다중성은 `attempts.jsonl`(append-only instance log)이 보존한다**
 * — 그것이 B-1의 답이고, "잃는 것은 파일 개수뿐"이라는 예전 문장은 audit 관점에서 틀렸다.
 *
 * **drift가 아닌 것**: 게이트 '검증' 재진입·reject 후 재실행은 **승인 전**이다 — 새 attempt는 새
 * receipt를 만들고 새 pending에 결박될 뿐, 이미 approved된 digest와 무관하다.
 * **drift인 것**: 승인 **후** 결박된 receipt/raw의 바이트가 바뀌는 것. 그때 막히는 것이 맞다.
 */
export function writeResearchReceipt(projectRoot, attempt) {
    const dir = join(projectRoot, RESEARCH_DIR_REL);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const body = receiptBody(attempt);
    const rel = `${RESEARCH_DIR_REL}/receipt-${sha256Of(body)}.json`;
    const abs = join(projectRoot, rel);
    let created = true;
    try {
        writeFileSync(abs, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    catch (err) {
        if (err.code !== "EEXIST")
            throw err;
        created = false;
        // 이미 있다 → **내용이 곧 이름**이므로 같은 바이트여야 한다. 아니면 남의 바이트이고 덮지 않는다
        // (evidenceStore의 EEXIST 재검증과 같은 규율 — hash 이름을 무조건 정답으로 접지 않는다).
        if (readFileSync(abs, "utf8") !== body) {
            throw new ResearchError("research_receipt_hash_mismatch", `content-addressed receipt 경로에 다른 바이트가 있다: ${rel} — 덮어쓰지 않고 거부한다`);
        }
    }
    // [B-1] 다중성 보존: seal마다 한 줄. `created:false`(같은 사실의 재발생)가 바로 그 정보다.
    appendFileSync(join(projectRoot, RESEARCH_ATTEMPT_LOG_REL), JSON.stringify({ sealed_at: attempt.started_at, mode: attempt.mode, error_code: attempt.error_code ?? null, receipt_path: rel, receipt_created: created }) + "\n", { encoding: "utf8", mode: 0o600 });
    return rel;
}
/** receipt 파일의 **정확한 바이트**. 쓰기와 검증이 같은 함수를 써야 exact-equal 대조가 성립한다. */
function receiptBody(attempt) {
    return JSON.stringify({ ...attempt, receipt_path: undefined }, null, 2) + "\n";
}
const RECEIPT_NAME_RE = new RegExp(`^${RESEARCH_DIR_REL}/receipt-([0-9a-f]{64})\\.json$`);
/**
 * [C-126/A-1] **resume 전에 영수증을 다시 검증한다.** `run_state.json`의 attempt 객체를 그대로 믿고
 * digest를 만들면, run_state의 `summary`/`source`/`sha256`만 바꿔도 **변조된 근거가 모델에 가고
 * checkpoint는 손대지 않은 옛 receipt/raw를 결박한다** — 모델이 소비한 근거 ≠ 승인된 근거.
 *
 * B-40의 `snapshotIdea`·B-41의 durable seed와 같은 규율이다: **정본은 저장본이고, 소비 직전에 그
 * 바이트를 다시 읽어 대조한다.**
 *
 * 검사 넷: ⓐ 경로 형태 ⓑ 파일 sha256 == 파일명 hash(content-addressed 자기 검증) ⓒ 파일 본문 ==
 * run_state attempt에서 재직렬화한 바이트(**exact-equal**) ⓓ 각 evidence의 raw 파일 **재해시**와
 * byte 수 대조. 하나라도 어긋나면 digest를 만들지 않는다.
 */
export function verifyResearchReceipt(projectRoot, attempt) {
    const m = RECEIPT_NAME_RE.exec(attempt.receipt_path);
    if (!m)
        return { ok: false, detail: `receipt 경로 형태가 아니다: ${attempt.receipt_path || "(없음)"}` };
    const abs = join(projectRoot, attempt.receipt_path);
    let onDisk;
    try {
        onDisk = readFileSync(abs, "utf8");
    }
    catch (err) {
        return { ok: false, detail: `receipt를 읽을 수 없다: ${attempt.receipt_path} (${err.message})` };
    }
    const actual = sha256Of(onDisk);
    if (actual !== m[1]) {
        return { ok: false, detail: `receipt 바이트가 파일명 hash와 다르다: ${attempt.receipt_path} (파일 ${actual})` };
    }
    if (onDisk !== receiptBody(attempt)) {
        return {
            ok: false,
            detail: `run_state의 리서치 기록이 저장된 영수증과 다르다: ${attempt.receipt_path} (run_state가 변조됐거나 손상됐다)`,
        };
    }
    // 저장본이 정본이므로 digest는 **receipt에서 파싱한 것**으로 만든다(run_state 객체가 아니다).
    const fromDisk = JSON.parse(onDisk);
    for (const it of fromDisk.evidence ?? []) {
        const rawAbs = join(projectRoot, RESEARCH_DIR_REL, it.rawPath);
        let bytes;
        try {
            bytes = readFileSync(rawAbs);
        }
        catch (err) {
            return { ok: false, detail: `근거 원본 파일을 읽을 수 없다: ${it.rawPath} (${err.message})` };
        }
        const h = createHash("sha256").update(bytes).digest("hex");
        if (h !== it.sha256 || bytes.length !== it.bytes) {
            return { ok: false, detail: `근거 파일이 영수증의 digest와 다르다: ${it.rawPath} (파일 ${h} · ${bytes.length}B)` };
        }
    }
    return { ok: true, attempt: { ...fromDisk, receipt_path: attempt.receipt_path } };
}
/** 문서 바이트의 sha256 — 1차 전문 신원(2차 요청문과 영수증이 같은 값을 쓴다). */
export function sha256Of(text) {
    return createHash("sha256").update(text, "utf8").digest("hex");
}
