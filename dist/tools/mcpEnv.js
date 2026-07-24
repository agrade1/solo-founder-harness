/**
 * [M3c-3b] blocking MCP 연결 env — **단일 출처**.
 *
 * Claude Code 2.1.x의 MCP 연결/handshake는 `MCP_CONNECT_TIMEOUT_MS`(기본 5000ms)로 제한된다.
 * filtered proxy는 cold `npx shadcn@4.13.1` + downstream exact-7 attestation 때문에 5초를 넘길 수 있어
 * system/init 시점에 서버가 `pending`으로 남아 `server_not_connected`가 된다.
 *
 * 타임아웃 여유 순서(cleanup 여지 확보):
 *   proxy downstream startup(30000ms) < Claude MCP 연결/handshake(45000ms) < headless preflight hard timeout(60000ms).
 *
 * 이 값은 preflight child env와 handoff-shadcn-readonly interactive spawn env 두 곳에서 동일하게 쓰이며,
 * **여기서만 정의**한다. 적용 시 반드시 **마지막에** 강제해 ambient process.env·testEnv가 override하지 못하게 한다.
 */
export const BLOCKING_MCP_ENV = Object.freeze({
    MCP_CONNECTION_NONBLOCKING: "0",
    MCP_CONNECT_TIMEOUT_MS: "45000",
    MCP_TIMEOUT: "45000",
});
/** 주어진 env에 blocking MCP 값을 **마지막에** 덮어써 강제한다(새 객체 반환, ambient/testEnv override 불가). */
export function applyBlockingMcpEnv(env) {
    return { ...env, ...BLOCKING_MCP_ENV };
}
