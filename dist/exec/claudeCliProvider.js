/**
 * claude CLI 헤드리스 실행 provider (ARCH §1, RECON §5 확정 인자형).
 *
 * ⚠ 잠정 구현 (Model A): `claude -p`는 호출당 1회성이라, 한 "세션"은
 * --session-id로 시작한 첫 invocation + 이후 --resume <id> invocation들의 논리적 묶음이다.
 * 매 turn 새 프로세스가 뜬다(컨텍스트는 --resume로 복원). 지속형 단일 프로세스
 * (Model B, --input-format stream-json으로 stdin 상주)와의 선택은 설계 미결
 * → docs/reference/EXECUTION_DESIGN_QUESTIONS.md Q1. 이 파일은 그 결정 후 재작성 가능.
 *
 * 실제 claude 호출 = 구독 토큰 소모. 단위 검증은 MockExecProvider + 파서 fixture로 하고,
 * 이 provider의 end-to-end 실행은 오케스트레이터·게이트가 붙은 뒤 승인하에 검증한다.
 */
import { spawn } from "node:child_process";
import { AsyncEventQueue } from "./eventQueue.js";
import { NdjsonParser } from "./streamParser.js";
const CLAUDE_BIN = process.env.HARNESS_CLAUDE_BIN ?? "claude";
/** stream-json print 모드 공통 인자 (RECON: print+stream-json은 --verbose 필수). */
function baseArgs(spec) {
    const args = ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose"];
    args.push("--permission-mode", spec.permissionMode ?? "acceptEdits");
    if (spec.model)
        args.push("--model", spec.model);
    if (spec.fallbackModel)
        args.push("--fallback-model", spec.fallbackModel);
    if (spec.allowedTools?.length)
        args.push("--allowedTools", spec.allowedTools.join(" "));
    if (spec.disallowedTools?.length)
        args.push("--disallowedTools", spec.disallowedTools.join(" "));
    for (const d of spec.addDirs ?? [])
        args.push("--add-dir", d);
    if (spec.role)
        args.push("--append-system-prompt", spec.role);
    return args;
}
export class ClaudeCliProvider {
    id = "claude-cli";
    sessions = new Map();
    async start(spec, initialPrompt) {
        const state = { spec, queue: new AsyncEventQueue(), child: null };
        this.sessions.set(spec.sessionId, state);
        this.invoke(state, ["--session-id", spec.sessionId], initialPrompt);
        return { sessionId: spec.sessionId, spec };
    }
    async send(handle, message) {
        const state = this.sessions.get(handle.sessionId);
        if (!state)
            throw new Error(`claude-cli: 없는 세션 ${handle.sessionId}`);
        state.queue = new AsyncEventQueue(); // 새 invocation = 새 이벤트 스트림
        this.invoke(state, ["--resume", handle.sessionId], message);
    }
    events(handle) {
        const state = this.sessions.get(handle.sessionId);
        if (!state)
            throw new Error(`claude-cli: 없는 세션 ${handle.sessionId}`);
        return state.queue;
    }
    async stop(handle, _reason) {
        const state = this.sessions.get(handle.sessionId);
        if (!state)
            return;
        state.child?.kill("SIGTERM");
        state.queue.close();
        this.sessions.delete(handle.sessionId);
    }
    /** 한 invocation을 spawn하고 stdout NDJSON을 파싱해 큐로 흘린다. */
    invoke(state, extraArgs, prompt) {
        const args = [...baseArgs(state.spec), ...extraArgs];
        const child = spawn(CLAUDE_BIN, args, { cwd: state.spec.cwd, stdio: ["pipe", "pipe", "pipe"] });
        state.child = child;
        const parser = new NdjsonParser();
        const queue = state.queue;
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            for (const e of parser.push(chunk))
                queue.push(e);
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", (err) => {
            // spawn 자체 실패 (claude 미설치/PATH). unknown 이벤트로 신호 후 종료.
            queue.push({ kind: "unknown", type: "spawn_error", sessionId: state.spec.sessionId, raw: { type: "spawn_error", message: err.message } });
            queue.close();
        });
        child.on("close", (code) => {
            for (const e of parser.flush())
                queue.push(e);
            if (code !== 0) {
                queue.push({
                    kind: "unknown",
                    type: "exit_error",
                    sessionId: state.spec.sessionId,
                    raw: { type: "exit_error", code, stderr: stderr.trim() },
                });
            }
            queue.close();
        });
        child.stdin.write(prompt);
        child.stdin.end();
    }
}
