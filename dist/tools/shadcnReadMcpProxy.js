import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { buildMcpConfig, McpConfigError } from "../providers/claudeCodeMcpAdapter.js";
import { redactSecrets, collectSecretValues } from "./redact.js";
import { checkComponentsJson, shadcnDiscoveryProfile, SHADCN_PACKAGE, SHADCN_SERVER } from "./shadcnPilot.js";
import { REQUEST_PROTOCOL_VERSION, isAllowedProtocolVersion, isAllowedTool, isForbiddenTool, getExpectedBare7, nsName, validateToolArgs, restrictedToolList, ShadcnPolicyError, MAX_TOOL_CALLS, PER_CALL_TIMEOUT_MS, SINGLE_RESPONSE_CAP, DS_STDOUT_CAP, DS_STDERR_CAP, UPSTREAM_LINE_CAP, RESULT_CHARS_BUDGET, MAX_TOOLSLIST_PAGES, } from "./shadcnReadPolicy.js";
/**
 * [V3 M3c-3a] shadcn **read-only filtering MCP proxy** (offline).
 *
 * upstream(향후 handoff/Claude host)에게는 MCP 서버로 동작하며 **읽기 후보 5개만**(bare name) 노출한다.
 * downstream `npx --yes shadcn@4.13.1 mcp`를 spawn해 허용된 호출만 전달하고, 응답 크기·형태를 강제한다.
 * `mcp__<server>__` prefix는 host가 만드는 이름이라 MCP 서버는 반환하지 않는다.
 *
 * signal(AbortSignal)은 downstream spawn 직후부터 연결돼, startup/in-flight 어느 시점이든 즉시 그룹 종료·
 * cleanup 후 종료한다(timeout 대기 없음). stdout은 JSON-RPC 전용, 진단은 짧은 stderr 코드만.
 */
const MAX_QUEUE = 64;
const MAX_TOTAL_REQUESTS = 256;
const SHUTDOWN_WAIT_MS = 3000;
export class ShadcnProxyError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "ShadcnProxyError";
        this.code = code;
    }
}
const ENV_ALLOWLIST = ["PATH", "SHELL", "LANG", "LC_ALL", "LC_CTYPE"];
function isPlainObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function canonicalJson(v) {
    if (Array.isArray(v))
        return "[" + v.map(canonicalJson).join(",") + "]";
    if (isPlainObject(v))
        return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
    return JSON.stringify(v) ?? "null";
}
function childEnv(home, npmCache) {
    const env = {};
    for (const k of ENV_ALLOWLIST) {
        const v = process.env[k];
        if (v !== undefined)
            env[k] = v;
    }
    env.HOME = home;
    env.npm_config_cache = npmCache;
    env.npm_config_update_notifier = "false";
    env.NO_UPDATE_NOTIFIER = "1";
    env.CI = "1";
    return env;
}
function validId(id) {
    return typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
}
function idKey(id) {
    return `${typeof id}:${id}`;
}
/** downstream(shadcn MCP) 좁은 JSON-RPC 클라이언트(순차 1건). fatal 오류는 즉시 그룹 종료. */
class DownstreamClient {
    scrub;
    child;
    decoder = new StringDecoder("utf8");
    buf = "";
    stdoutBytes = 0;
    stderrBytes = 0;
    nextId = 1;
    terminated = false;
    pending = null;
    dead = false;
    deadReason = "";
    pid;
    constructor(command, args, serviceCwd, home, npmCache, scrub) {
        this.scrub = scrub;
        this.child = spawn(command, args, { cwd: serviceCwd, env: childEnv(home, npmCache), stdio: ["pipe", "pipe", "pipe"], detached: true });
        this.pid = this.child.pid ?? null;
        this.child.stdin.on("error", () => { });
        this.child.stdout.on("data", (d) => this.onStdout(d));
        this.child.stderr.on("data", (d) => {
            this.stderrBytes += d.length;
            if (this.stderrBytes > DS_STDERR_CAP)
                this.markDead("ds_stderr_too_large");
        });
        this.child.on("error", (e) => this.markDead("ds_spawn", e.message));
        this.child.on("close", () => {
            if (!this.dead)
                this.markDead("ds_closed");
        });
    }
    /** 단일 종료 함수 — group SIGKILL(실패 시 단일 kill). markDead·shutdown 공용. */
    terminateProcessGroup() {
        if (this.terminated)
            return;
        this.terminated = true;
        try {
            if (this.pid)
                process.kill(-this.pid, "SIGKILL");
            else
                this.child.kill("SIGKILL");
        }
        catch {
            try {
                this.child.kill("SIGKILL");
            }
            catch {
                /* ignore */
            }
        }
    }
    /** fatal — pending 즉시 reject(+timer clear) 후 그룹 종료. abort/timeout/계약위반 공용. */
    markDead(reason, _detail) {
        if (this.dead)
            return;
        this.dead = true;
        this.deadReason = reason;
        if (this.pending) {
            clearTimeout(this.pending.timer);
            const p = this.pending;
            this.pending = null;
            p.reject(new ShadcnProxyError(reason, this.scrub(`downstream ${reason}`)));
        }
        this.terminateProcessGroup();
    }
    onStdout(d) {
        if (this.dead)
            return;
        this.stdoutBytes += d.length;
        if (this.stdoutBytes > DS_STDOUT_CAP)
            return this.markDead("ds_stdout_too_large");
        this.buf += this.decoder.write(d);
        let idx;
        while ((idx = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, idx);
            this.buf = this.buf.slice(idx + 1);
            if (this.dead)
                return;
            this.onLine(line);
        }
    }
    onLine(line) {
        const t = line.trim();
        if (t.length === 0)
            return;
        if (Buffer.byteLength(line, "utf8") > SINGLE_RESPONSE_CAP)
            return this.markDead("ds_response_too_large");
        let msg;
        try {
            msg = JSON.parse(t);
        }
        catch {
            return this.markDead("ds_malformed");
        }
        if (!isPlainObject(msg) || msg.jsonrpc !== "2.0")
            return this.markDead("ds_bad_jsonrpc");
        if (!("id" in msg) || msg.id === undefined)
            return; // downstream notification 무시
        const p = this.pending;
        if (!p || msg.id !== p.id)
            return this.markDead("ds_id_mismatch");
        clearTimeout(p.timer);
        this.pending = null;
        if (msg.error !== undefined)
            return p.reject(new ShadcnProxyError("ds_error", "downstream JSON-RPC error")); // 일반 tool error — 세션 유지
        if (!isPlainObject(msg.result)) {
            // 응답 계약 위반 → fatal.
            p.reject(new ShadcnProxyError("ds_bad_result", "downstream result 누락"));
            this.markDead("ds_bad_result");
            return;
        }
        p.resolve(msg.result);
    }
    notify(method) {
        if (this.dead || !this.child.stdin.writable)
            return;
        this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
    }
    request(method, params, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (this.dead)
                return reject(new ShadcnProxyError(this.deadReason || "ds_dead", "downstream 사용 불가"));
            if (this.pending)
                return reject(new ShadcnProxyError("ds_busy", "downstream 요청 중복"));
            const id = ++this.nextId;
            const timer = setTimeout(() => {
                if (this.pending && this.pending.id === id) {
                    this.pending = null;
                    reject(new ShadcnProxyError("call_timeout", this.scrub(`downstream 타임아웃 (${timeoutMs}ms)`)));
                    this.markDead("ds_timeout");
                }
            }, timeoutMs);
            this.pending = { id, resolve, reject, timer };
            if (!this.child.stdin.writable) {
                clearTimeout(timer);
                this.pending = null;
                return reject(new ShadcnProxyError("ds_dead", "downstream stdin 불가"));
            }
            this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        });
    }
    /** 그룹 종료 + close bounded wait. */
    async shutdown() {
        return new Promise((resolve) => {
            let done = false;
            const fin = (ok) => {
                if (!done) {
                    done = true;
                    resolve(ok);
                }
            };
            if (this.child.exitCode !== null || this.child.signalCode !== null) {
                this.terminateProcessGroup();
                return fin(true);
            }
            this.child.on("close", () => fin(true));
            this.terminateProcessGroup();
            setTimeout(() => fin(false), SHUTDOWN_WAIT_MS);
        });
    }
}
/** downstream CallToolResult를 실측 계약으로 강제(정책 거부 — downstream을 죽이지 않음). */
function sanitizeCallResult(result) {
    if (!isPlainObject(result))
        throw new ShadcnPolicyError("bad_result", "result 객체 아님");
    if (result.isError === true)
        throw new ShadcnPolicyError("tool_is_error", "isError=true");
    if (result.structuredContent !== undefined)
        throw new ShadcnPolicyError("structured_present", "structuredContent 존재(계약 밖)");
    const content = result.content;
    if (!Array.isArray(content) || content.length === 0)
        throw new ShadcnPolicyError("empty_result", "content 비어 있음");
    const out = [];
    for (const b of content) {
        if (!isPlainObject(b) || b.type !== "text" || typeof b.text !== "string")
            throw new ShadcnPolicyError("non_text", "text 이외 block(계약 밖)");
        out.push({ type: "text", text: b.text });
    }
    const canonical = canonicalJson({ content, structuredContent: null, isError: result.isError ?? false });
    if (canonical.length > RESULT_CHARS_BUDGET)
        throw new ShadcnPolicyError("result_too_large", `resultChars ${RESULT_CHARS_BUDGET} 초과 — 원문 미전달`);
    return { content: out };
}
export function runShadcnReadProxy(opts) {
    const perCallTimeoutMs = opts.perCallTimeoutMs ?? PER_CALL_TIMEOUT_MS;
    const startupTimeoutMs = opts.startupTimeoutMs ?? 30_000;
    const input = opts.input ?? process.stdin;
    const output = opts.output ?? process.stdout;
    const diag = opts.onDiagnostic ?? (() => { });
    const secretValues = collectSecretValues(opts.redactNames ?? []);
    const scrub = (s) => redactSecrets(s, secretValues);
    const { serviceCwd } = opts;
    // 0) 표준 registry 검사 — child/config 생성 전(spawn 없음).
    const reg = checkComponentsJson(serviceCwd);
    if (!reg.ok)
        return Promise.reject(new ShadcnProxyError(`registry_${reg.code}`, scrub(`components.json 표준 registry 검사 실패 (${reg.code})`)));
    // 1) downstream 명령 고정(pin 강제).
    let command;
    let args;
    try {
        const built = buildMcpConfig(shadcnDiscoveryProfile());
        const entry = built.config.mcpServers[SHADCN_SERVER];
        command = entry.command ?? "";
        args = entry.args ?? [];
        if (command !== "npx" || JSON.stringify(args) !== JSON.stringify(["--yes", SHADCN_PACKAGE, "mcp"]))
            throw new ShadcnProxyError("config_command", "downstream 명령이 정확히 npx --yes shadcn@4.13.1 mcp 아님");
    }
    catch (e) {
        if (e instanceof ShadcnProxyError)
            return Promise.reject(e);
        if (e instanceof McpConfigError)
            return Promise.reject(new ShadcnProxyError(`config_${e.code}`, scrub(e.message)));
        return Promise.reject(new ShadcnProxyError("config", scrub(e.message)));
    }
    // 2) 임시 HOME/cache + spawn + startup + serve를 하나의 관리 Promise에서 공유(공통 finalize).
    const childHome = mkdtempSync(join(tmpdir(), "m3c3-home-"));
    const npmCache = join(childHome, "npm-cache");
    return new Promise((resolve, reject) => {
        let settled = false;
        let aborted = false;
        let ds = null;
        let abortListener = null;
        const removeAbort = () => {
            if (opts.abortSignal && abortListener)
                opts.abortSignal.removeEventListener("abort", abortListener);
            abortListener = null;
        };
        const cleanup = async () => {
            let closedOk = true;
            if (ds)
                closedOk = await ds.shutdown();
            if (opts.cleanupFaultForTest) {
                try {
                    rmSync(childHome, { recursive: true, force: true });
                }
                catch {
                    /* ignore */
                }
                return false; // [TEST-ONLY] 실패로 보고(shutdown은 수행)
            }
            if (!closedOk)
                return false; // descendant 종료 확인 후에만 삭제
            try {
                rmSync(childHome, { recursive: true, force: true });
                return !existsSync(childHome);
            }
            catch {
                return false;
            }
        };
        // serve/보고 상태.
        let toolCalls = 0;
        let forbiddenAttempts = 0;
        let rejectedCalls = 0;
        let totalRequests = 0;
        const calledTools = [];
        let dsProtocolVersion = "";
        // 공통 종료(정확히 한 번). signal/child close 경합에도 settled 가드로 cleanup 1회.
        const doResolve = (reason) => {
            if (settled)
                return;
            settled = true;
            removeAbort();
            input.removeListener("data", onData);
            void cleanup().then((cleanupOk) => resolve({ startupOk: true, reason, toolCalls, calledTools, forbiddenAttempts, rejectedCalls, downstreamPid: ds ? ds.pid : null, cleanupOk }));
        };
        const rejectStartup = (err) => {
            if (settled)
                return;
            settled = true;
            removeAbort();
            void cleanup().then((ok) => reject(ok ? err : new ShadcnProxyError("cleanup_failed", scrub("startup 실패 후 임시 HOME 정리 실패"))));
        };
        const onAbort = () => {
            if (settled)
                return;
            aborted = true;
            if (ds)
                ds.markDead("aborted"); // pending 즉시 해제 + 그룹 종료(timeout 대기 없음)
            doResolve("signal");
        };
        // ── downstream spawn (직후부터 abort 연결) ──
        try {
            mkdirSync(npmCache, { recursive: true });
            ds = new DownstreamClient(command, args, serviceCwd, childHome, npmCache, scrub);
        }
        catch (e) {
            rejectStartup(new ShadcnProxyError("ds_spawn", scrub(e.message)));
            return;
        }
        if (opts.abortSignal) {
            if (opts.abortSignal.aborted) {
                onAbort();
                return;
            }
            abortListener = onAbort;
            opts.abortSignal.addEventListener("abort", abortListener);
        }
        // ── serve 상태 머신 (startup 성공 후 시작) ──
        const decoder = new StringDecoder("utf8");
        let ubuf = "";
        const seenIds = new Set();
        let upstreamEnded = false;
        let endReason = "upstream_end";
        let fatal = false;
        let state = "init";
        const queue = [];
        let processing = false;
        const writeMsg = (msg) => {
            if (settled)
                return; // 종료 후 stdout 미기록(불완전/추가 출력 방지)
            try {
                output.write(JSON.stringify(msg) + "\n");
            }
            catch {
                /* upstream 끊김 */
            }
        };
        const respondError = (id, code, message) => writeMsg({ jsonrpc: "2.0", id: validId(id) ? id : null, error: { code, message } });
        const maybeFinalize = () => {
            if ((upstreamEnded || fatal) && !processing && queue.length === 0)
                doResolve(fatal ? "downstream_fatal" : endReason);
        };
        const handleToolsCall = async (id, params) => {
            const p = isPlainObject(params) ? params : {};
            const name = typeof p.name === "string" ? p.name : "";
            if (name.startsWith("mcp__")) {
                rejectedCalls++;
                return respondError(id, -32601, "unknown tool");
            }
            if (isForbiddenTool(name)) {
                forbiddenAttempts++;
                return respondError(id, -32601, "forbidden tool");
            }
            if (!isAllowedTool(name)) {
                rejectedCalls++;
                return respondError(id, -32601, "unknown tool");
            }
            if (toolCalls >= MAX_TOOL_CALLS) {
                rejectedCalls++;
                return respondError(id, -32000, "tool call limit reached");
            }
            let validated;
            try {
                validated = validateToolArgs(name, p.arguments);
            }
            catch (e) {
                rejectedCalls++;
                diag(e.code ?? "policy");
                return respondError(id, -32602, "invalid arguments"); // 정책 거부 — 세션 유지
            }
            toolCalls++;
            calledTools.push(nsName(name));
            try {
                const result = await ds.request("tools/call", { name, arguments: validated }, perCallTimeoutMs);
                writeMsg({ jsonrpc: "2.0", id, result: sanitizeCallResult(result) });
            }
            catch (e) {
                const code = e.code ?? "call_failed";
                diag(code);
                respondError(id, -32000, code === "result_too_large" ? "result exceeds budget" : "tool call failed");
                if (ds.dead)
                    fatal = true; // downstream fatal → 안전 오류 응답 후 finalize (정책 거부는 유지)
            }
        };
        const handleRequest = async (msg) => {
            const id = msg.id;
            const method = msg.method;
            const key = idKey(id);
            if (seenIds.has(key))
                return respondError(id, -32600, "duplicate id");
            seenIds.add(key);
            if (method === "initialize") {
                if (state !== "init")
                    return respondError(id, -32600, "already initialized");
                state = "initialized_pending";
                return writeMsg({ jsonrpc: "2.0", id, result: { protocolVersion: dsProtocolVersion, capabilities: { tools: {} }, serverInfo: { name: "shadcn-read-proxy", version: "0.1.0" } } });
            }
            if (state !== "ready")
                return respondError(id, -32600, "not initialized");
            if (method === "tools/list")
                return writeMsg({ jsonrpc: "2.0", id, result: { tools: restrictedToolList() } });
            if (method === "tools/call")
                return handleToolsCall(id, msg.params);
            return respondError(id, -32601, "method not found");
        };
        const handleNotification = (msg) => {
            if (msg.method === "notifications/initialized" && state === "initialized_pending")
                state = "ready";
        };
        const drain = async () => {
            if (processing)
                return;
            processing = true;
            while (queue.length > 0 && !fatal && !settled) {
                const msg = queue.shift();
                if ("id" in msg && msg.id !== undefined)
                    await handleRequest(msg);
                else
                    handleNotification(msg);
            }
            if (fatal)
                queue.length = 0;
            processing = false;
            maybeFinalize();
        };
        const onUpstreamLine = (line) => {
            const t = line.trim();
            if (t.length === 0)
                return;
            if (Buffer.byteLength(line, "utf8") > UPSTREAM_LINE_CAP)
                return respondError(null, -32700, "line too large");
            let msg;
            try {
                msg = JSON.parse(t);
            }
            catch {
                return respondError(null, -32700, "parse error");
            }
            if (!isPlainObject(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
                return respondError(isPlainObject(msg) && validId(msg.id) ? msg.id : null, -32600, "invalid request");
            }
            const hasId = "id" in msg && msg.id !== undefined;
            if (hasId && !validId(msg.id))
                return respondError(null, -32600, "invalid id");
            if (hasId) {
                totalRequests++;
                if (totalRequests > MAX_TOTAL_REQUESTS)
                    return respondError(msg.id, -32000, "too many requests");
            }
            if (queue.length >= MAX_QUEUE)
                return respondError(hasId ? msg.id : null, -32000, "queue full");
            queue.push(msg);
            void drain();
        };
        function onData(d) {
            ubuf += typeof d === "string" ? d : decoder.write(d);
            if (Buffer.byteLength(ubuf, "utf8") > UPSTREAM_LINE_CAP && ubuf.indexOf("\n") < 0) {
                respondError(null, -32700, "line too large");
                ubuf = "";
                return;
            }
            let idx;
            while ((idx = ubuf.indexOf("\n")) >= 0) {
                const line = ubuf.slice(0, idx);
                ubuf = ubuf.slice(idx + 1);
                onUpstreamLine(line);
            }
        }
        const startServe = () => {
            input.on("data", onData);
            input.on("end", () => {
                upstreamEnded = true;
                endReason = "upstream_end";
                maybeFinalize();
            });
            input.on("error", () => {
                upstreamEnded = true;
                endReason = "upstream_error";
                maybeFinalize();
            });
        };
        // ── startup: downstream init → tools/list 실측 7개 정확 일치 ──
        void (async () => {
            try {
                const initR = await ds.request("initialize", { protocolVersion: REQUEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "shadcn-read-proxy", version: "0" } }, startupTimeoutMs);
                if (aborted || settled)
                    return;
                if (!isAllowedProtocolVersion(initR.protocolVersion))
                    throw new ShadcnProxyError("ds_protocol_version", "downstream protocolVersion 미허용");
                if (!isPlainObject(initR.capabilities) || !isPlainObject(initR.capabilities.tools))
                    throw new ShadcnProxyError("ds_capabilities", "downstream capabilities.tools 아님");
                const si = initR.serverInfo;
                if (!isPlainObject(si) || typeof si.name !== "string" || !si.name || typeof si.version !== "string" || !si.version)
                    throw new ShadcnProxyError("ds_server_info", "downstream serverInfo 누락");
                dsProtocolVersion = initR.protocolVersion;
                ds.notify("notifications/initialized");
                const bare = new Set();
                let cursor;
                const cursorsSeen = new Set();
                for (let page = 0; page < MAX_TOOLSLIST_PAGES; page++) {
                    const r = await ds.request("tools/list", cursor === undefined ? {} : { cursor }, startupTimeoutMs);
                    if (aborted || settled)
                        return;
                    if (!Array.isArray(r.tools))
                        throw new ShadcnProxyError("ds_tools", "downstream tools/list 배열 아님");
                    for (const t of r.tools) {
                        if (!isPlainObject(t) || typeof t.name !== "string" || !t.name)
                            throw new ShadcnProxyError("ds_tools", "downstream tool.name 누락");
                        if (bare.has(t.name))
                            throw new ShadcnProxyError("ds_duplicate_tool", "downstream 중복 도구");
                        bare.add(t.name);
                    }
                    const nc = r.nextCursor;
                    if (nc === undefined || nc === null) {
                        cursor = undefined;
                        break;
                    }
                    if (typeof nc !== "string" || !nc || cursorsSeen.has(nc))
                        throw new ShadcnProxyError("ds_cursor", "downstream cursor 이상");
                    cursorsSeen.add(nc);
                    cursor = nc;
                    if (page === MAX_TOOLSLIST_PAGES - 1)
                        throw new ShadcnProxyError("ds_too_many_pages", "downstream tools/list 페이지 초과");
                }
                if (JSON.stringify([...bare].sort()) !== JSON.stringify(getExpectedBare7()))
                    throw new ShadcnProxyError("ds_tools_mismatch", "downstream 도구 목록이 실측 7개와 불일치");
                if (aborted || settled)
                    return;
                startServe();
            }
            catch (e) {
                if (aborted || settled)
                    return; // abort가 이미 signal로 종료 처리 중
                rejectStartup(e instanceof ShadcnProxyError ? new ShadcnProxyError(e.code, scrub(e.message)) : new ShadcnProxyError("ds_startup", scrub(e.message)));
            }
        })();
    });
}
/** 실행 진입점: serviceCwd=cwd, stdin/stdout으로 proxy 구동. stdout은 JSON-RPC 전용. */
export async function main() {
    const ac = new AbortController();
    let signalCode = 0;
    const onSig = (code) => () => {
        signalCode = code;
        ac.abort();
    };
    process.once("SIGINT", onSig(130));
    process.once("SIGTERM", onSig(143));
    const flushExit = (code) => {
        let exited = false;
        const done = () => {
            if (exited)
                return;
            exited = true;
            process.exit(code);
        };
        try {
            process.stdout.write("", () => done());
        }
        catch {
            done();
        }
        setTimeout(done, 500).unref?.();
    };
    try {
        const r = await runShadcnReadProxy({ serviceCwd: process.cwd(), now: () => new Date().toISOString(), abortSignal: ac.signal });
        if (signalCode)
            return flushExit(signalCode); // SIGINT=130 / SIGTERM=143 (proxy_error/1로 바꾸지 않음)
        if (!r.cleanupOk) {
            process.stderr.write("cleanup_failed\n");
            return flushExit(1);
        }
        return flushExit(0);
    }
    catch (e) {
        const code = e instanceof ShadcnProxyError ? e.code : "proxy_error";
        process.stderr.write(String(code) + "\n"); // 짧은 code만
        return flushExit(1);
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void main();
}
