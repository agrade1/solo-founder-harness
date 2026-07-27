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
 * **오류 코드 taxonomy는 닫혀 있다(2차 리비전 A5b).** 이전 판은 "문자열 `code`를 가진 Error"면 무엇이든
 * 그대로 통과시켰으므로, provider iterator가 `code = "result_accepted"` 같은 **오케스트레이션 결과 코드**를
 * 달아 던지는 것만으로 실패 outcome에 성공처럼 보이는 marker를 심을 수 있었다. 이제 이 함수가 **자기가
 * 만든 오류만** 통과시키고(참조 동일성) 나머지는 전부 `codes.streamFailed`로 접는다 —
 * provider는 자기 실패의 **분류를 고를 수 없다**(transcript·경로도 오류에 싣지 않는다).
 *
 * `onTerminal`은 종료 결과가 **정확히 1건으로 확정된 뒤 · 성공/실패를 해석하기 전에** 정확히 한 번
 * 불린다(2차 리비전 A3). 실패한 turn이 태운 토큰도 예산에서 빠지게 하는 지점이며, 여기서 던지는
 * 오류(예산 소진 등)는 호출자 것이므로 그대로 올라간다.
 */
export async function consumeExactlyOneTerminal(stream, codes, maxEvents, ErrorType, onTerminal) {
    let result = null;
    let seen = 0;
    /**
     * 이 함수가 **직접 만든** 오류. 이 참조만 통과한다 — 흉내낸 코드·이름은 통과하지 못한다.
     * `null` 초기값을 쓰지 않는 이유: provider가 `throw null`을 하면 `err === mine`이 참이 된다.
     */
    let mine;
    const own = (code, message) => {
        mine = new ErrorType(code, message);
        return mine;
    };
    try {
        for await (const e of stream) {
            if (++seen > maxEvents)
                throw own(codes.unbounded, "스트림이 이벤트 상한을 넘었다");
            // 종료 뒤에는 아무 것도 오지 않는다 — 두 번째 종료 결과도, 늦은 assistant·status도 거부다.
            if (result)
                throw own(codes.duplicate, "종료 결과 뒤에 이벤트가 더 왔다(종료는 정확히 1건이다)");
            if (e.kind === "result")
                result = e;
        }
    }
    catch (err) {
        if (mine !== undefined && err === mine)
            throw err;
        throw new ErrorType(codes.streamFailed, "스트림 소비가 실패했다");
    }
    if (!result)
        throw new ErrorType(codes.noResult, "이 스트림에 종료 결과가 없다");
    // **성공·실패 해석 전에** 종료 1건을 회계한다(실패한 turn의 usage도 예산에서 빠진다).
    onTerminal?.(result);
    if (result.isError) {
        throw new ErrorType(codes.resultError, `turn이 실패로 끝났다(${result.terminalReason ?? "unknown"})`);
    }
    return result;
}
