/**
 * 실행 계층 타입 (EXECUTION_LAYER_ARCH §1·§3, EXECUTION_CLI_RECON §3 기반).
 * SessionEvent는 claude -p stream-json 이벤트를 오케스트레이터가 쓰는 형태로 정규화한 것.
 * 파서·provider·오케스트레이터가 공유한다.
 */
/** result 이벤트인지 (= 한 invocation의 종료 신호). */
export function isTerminal(e) {
    return e.kind === "result";
}
/**
 * **한 invocation의 스트림에서 종료 결과를 정확히 하나만 받는다**(V3 M5b — 독립 리뷰 A5 · 대장 `B-8`).
 *
 * 이전 판의 소비자들(`reviewer.ts` · `StableController`)은 `if (e.kind === "result") result = e`로
 * **마지막 종료 결과가 앞의 것을 덮었다** → 실패 종료 뒤에 성공 종료가 오면 성공으로 읽혔다.
 * 여기서는 ⓐ 종료 결과 뒤의 **모든** 이벤트(두 번째 종료 결과 포함)를 거부하고 ⓑ 종료 결과가 없으면
 * 거부하고 ⓒ `isError`면 거부한다. 소비자가 다르므로 코드만 호출자가 준다(로직은 하나다).
 *
 * provider가 올린 `OrchestrationError`는 **안정 코드를 그대로 통과**시키고, 그 밖의 예외만
 * `codes.streamFailed`로 접는다(transcript·경로를 오류에 싣지 않는다).
 */
export async function consumeExactlyOneTerminal(stream, codes, maxEvents, ErrorType) {
    let result = null;
    let seen = 0;
    try {
        for await (const e of stream) {
            if (++seen > maxEvents)
                throw new ErrorType(codes.unbounded, "스트림이 이벤트 상한을 넘었다");
            // 종료 뒤에는 아무 것도 오지 않는다 — 두 번째 종료 결과도, 늦은 assistant·status도 거부다.
            if (result)
                throw new ErrorType(codes.duplicate, "종료 결과 뒤에 이벤트가 더 왔다(종료는 정확히 1건이다)");
            if (e.kind === "result")
                result = e;
        }
    }
    catch (err) {
        if (err instanceof Error && typeof err.code === "string")
            throw err;
        throw new ErrorType(codes.streamFailed, "스트림 소비가 실패했다");
    }
    if (!result)
        throw new ErrorType(codes.noResult, "이 스트림에 종료 결과가 없다");
    if (result.isError) {
        throw new ErrorType(codes.resultError, `turn이 실패로 끝났다(${result.terminalReason ?? "unknown"})`);
    }
    return result;
}
/**
 * **read-only 실행 계약 brand**(V3 M5b — 독립 리뷰 A2).
 *
 * `StableController`는 read-only Codex planning/review bridge **전용**이다. provider를
 * `id === "codex-cli"` 같은 **문자열**로 판정하면 아무 객체나 같은 id를 달고 들어올 수 있으므로,
 * read-only·strict-empty-MCP 실행 계약을 **실제로 집행하는 구현**(`CodexCliProvider`)이 자기
 * 인스턴스에 이 심볼을 달고, controller는 **그 심볼 참조**로만 수락한다.
 *
 * **이것이 보장하는 것**: 문자열 id·`spec` 위조만으로는 bridge에 못 들어온다(nominal typing).
 * **보장하지 않는 것**: 같은 프로세스 안의 코드는 이 모듈을 import해 brand를 달 수 있다 —
 * 즉 프로세스 내 격리가 아니라 **레포 안의 명시 계약**이다. 그래서 테스트 seam은 숨기지 않고
 * "brand를 명시적으로 다는 in-process provider"라는 형태로 드러내 둔다(production 경로는 열리지 않는다:
 * production 호출자는 `CodexCliProvider`를 쓰거나 `controller_provider_not_read_only`로 거부된다).
 */
export const READ_ONLY_EXECUTION_CONTRACT = Symbol("v3.readOnlyExecutionContract");
/** brand가 달린 provider만 read-only bridge를 지난다. */
export function hasReadOnlyExecutionContract(provider) {
    return (typeof provider === "object" &&
        provider !== null &&
        provider[READ_ONLY_EXECUTION_CONTRACT] === true);
}
