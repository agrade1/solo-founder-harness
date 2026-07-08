/**
 * 실행 계층 타입 (EXECUTION_LAYER_ARCH §1·§3, EXECUTION_CLI_RECON §3 기반).
 * SessionEvent는 claude -p stream-json 이벤트를 오케스트레이터가 쓰는 형태로 정규화한 것.
 * 파서·provider·오케스트레이터가 공유한다.
 */
/** result 이벤트인지 (= 한 invocation의 종료 신호). */
export function isTerminal(e) {
    return e.kind === "result";
}
