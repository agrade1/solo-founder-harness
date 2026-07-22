/**
 * secret reference 검증 + redaction (V3 MCP M2, §7.3).
 *
 * - secretRefs는 환경변수 "이름"만 담아야 한다(값 금지). 형식 검증으로 값 유출을 막는다.
 * - redactSecrets는 직렬화된 config/error/trace 문자열에서 secret 값·자격증명 패턴을 가린다.
 */
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
/** 환경변수 이름 형식인지. (값처럼 보이는 문자열은 거부하기 위함) */
export function isValidSecretRef(name) {
    return ENV_NAME_RE.test(name);
}
/**
 * secretRefs 배열을 검증한다. 이름 형식이 아니면 throw (값이 잘못 들어간 경우 차단).
 * 오류 메시지에는 입력값을 절대 포함하지 않는다 — 위반이 secret 값일 수 있으므로 index만 알린다.
 */
export function assertValidSecretRefs(refs, profileId) {
    const badIndexes = [];
    refs.forEach((r, i) => {
        if (!isValidSecretRef(r))
            badIndexes.push(i);
    });
    if (badIndexes.length > 0) {
        throw new Error(`profile '${profileId}': secretRefs는 환경변수 이름(^[A-Z][A-Z0-9_]*$)만 허용한다(값 금지). ` +
            `형식 위반 index: [${badIndexes.join(", ")}] (값은 노출하지 않음)`);
    }
}
const REDACTED = "***";
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
 * 텍스트에서 secret을 가린다.
 *  - values: 실제 secret 값(있으면 정확 치환)
 *  - Authorization 헤더 값, `key=`/`token=`/`secret=` 쿼리·kv 값도 패턴으로 가린다.
 */
export function redactSecrets(text, values = []) {
    let out = text;
    for (const v of values) {
        if (v)
            out = out.split(v).join(REDACTED); // 비어있지 않은 값은 길이와 무관하게 치환 (1~3자 포함)
    }
    // Authorization: Bearer xxx  /  Authorization: xxx
    out = out.replace(/(authorization"?\s*[:=]\s*"?)(bearer\s+)?[^\s"',}]+/gi, `$1$2${REDACTED}`);
    // key=xxx / token=xxx / secret=xxx / api_key=xxx (쿼리·kv)
    out = out.replace(/((?:api[_-]?key|apikey|token|secret|password)"?\s*[:=]\s*"?)[^\s"',&}]+/gi, `$1${REDACTED}`);
    return out;
}
/** 환경변수 이름 목록에서 현재 process.env의 값을 모아 redaction용 값 배열로 만든다. */
export function collectSecretValues(names, env = process.env) {
    const vals = [];
    for (const n of names) {
        const v = env[n];
        if (v)
            vals.push(v);
    }
    return vals;
}
// escapeRegex는 향후 패턴 확장을 위해 export하지 않고 내부 보관.
void escapeRegex;
