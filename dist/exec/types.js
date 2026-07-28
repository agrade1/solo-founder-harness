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
export async function consumeExactlyOneTerminal(stream, codes, maxEvents, makeError, onTerminal) {
    let result = null;
    let seen = 0;
    /**
     * **그대로 올려보낼 오류**: 이 함수가 직접 만든 것 또는 `onTerminal`(호출자 코드)이 던진 것.
     * 참조 동일성으로만 판정한다 — 흉내낸 코드·이름은 통과하지 못한다.
     * `null` 초기값을 쓰지 않는 이유: provider가 `throw null`을 하면 `err === mine`이 참이 된다.
     */
    let mine;
    const own = (code, message) => {
        const e = makeError(code, message);
        mine = e;
        return e;
    };
    try {
        for await (const e of stream) {
            if (++seen > maxEvents)
                throw own(codes.unbounded, "스트림이 이벤트 상한을 넘었다");
            // 종료 뒤에는 아무 것도 오지 않는다 — 두 번째 종료 결과도, 늦은 assistant·status도 거부다.
            if (result)
                throw own(codes.duplicate, "종료 결과 뒤에 이벤트가 더 왔다(종료는 정확히 1건이다)");
            if (e.kind === "result") {
                result = e;
                // 회계는 **여기서 정확히 한 번**이다(위 `if (result)` 가드가 두 번째 진입을 막는다).
                try {
                    onTerminal?.(e);
                }
                catch (err) {
                    mine = err; // 호출자(예산 게이트) 오류는 접지 않고 그대로 올린다
                    throw err;
                }
            }
        }
    }
    catch (err) {
        if (mine !== undefined && err === mine)
            throw err;
        throw makeError(codes.streamFailed, "스트림 소비가 실패했다");
    }
    if (!result)
        throw makeError(codes.noResult, "이 스트림에 종료 결과가 없다");
    if (result.isError) {
        throw makeError(codes.resultError, `turn이 실패로 끝났다(${result.terminalReason ?? "unknown"})`);
    }
    return result;
}
