#!/usr/bin/env node
/**
 * [M3a LIVE ACCEPTANCE FIXTURE — 수동 live acceptance 전용, production 아님]
 *
 * 이것은 **canary acceptance 용 최소 stdio MCP 서버**다. 실제 제품용 MCP server/client 구현이 아니다.
 * 목적: preflight가 실제 claude로 뜰 때, strict-mcp-config가 이 서버(그리고 도구 1개)만 노출하고
 * ambient .mcp.json의 canary 서버는 제외하는지 실측하기 위한 테스트 더블.
 *
 * newline-delimited JSON-RPC 2.0(stdio)로 initialize / tools/list 최소 응답만 한다.
 * 노출 도구는 read-only 1개뿐. argv: <serverLabel> <toolName> [pidFile].
 * pidFile 지정 시 기동 즉시 pid를 기록한다 → runner가 실제 기동/격리/종료를 검증한다.
 */
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const label = process.argv[2] || "fixture";
const toolName = process.argv[3] || "read_thing";
const pidFile = process.argv[4];

// 실제 기동 증거: pid-file 생성 (canary는 strict가 차단하면 이 코드에 도달하지 않음).
// 기록 실패는 무시하지 않는다 — sentinel 없는 일반 오류를 남기고 non-zero 종료(→ 서버 미연결로 fail-closed).
if (pidFile) {
  try {
    writeFileSync(pidFile, String(process.pid), "utf8");
  } catch (e) {
    process.stderr.write(`fixture pid-file 기록 실패: ${(e && e.code) || "unknown"}\n`);
    process.exit(1);
  }
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let req;
  try {
    req = JSON.parse(t);
  } catch {
    return;
  }
  const { id, method, params } = req;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: label, version: "0.0.0" },
      },
    });
  } else if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: toolName,
            description: `read-only fixture tool (${label}) — canary acceptance only`,
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      },
    });
  } else if (method === "tools/call") {
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }], isError: false } });
  } else if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
  // notifications(no id)는 무시
});
