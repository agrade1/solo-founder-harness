/**
 * 버퍼링 방식 프로세스 실행 (worktree git 명령·기계 게이트 공용).
 * stdout/stderr를 모아 종료 시 한 번에 반환. (스트리밍이 필요한 claude 세션은 claudeCliProvider가 별도 처리)
 */
import { spawn } from "node:child_process";
/** 명령을 실행하고 결과를 버퍼링해 반환. spawn 실패(미설치 등)는 reject. */
export function runProcess(command, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const child = spawn(command, args, {
            cwd: opts.cwd,
            env: opts.env ?? process.env,
            stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timer;
        if (opts.timeoutMs && opts.timeoutMs > 0) {
            timer = setTimeout(() => {
                child.kill("SIGKILL");
                reject(new Error(`실행 타임아웃 (${opts.timeoutMs}ms): ${command} ${args.join(" ")}`));
            }, opts.timeoutMs);
        }
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (d) => (stdout += d));
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (d) => (stderr += d));
        child.on("error", (err) => {
            if (timer)
                clearTimeout(timer);
            reject(new Error(`실행 실패 (${command}): ${err.message}`));
        });
        child.on("close", (code) => {
            if (timer)
                clearTimeout(timer);
            resolve({ code, stdout, stderr, durationMs: Date.now() - startedAt });
        });
        if (opts.input !== undefined) {
            child.stdin?.write(opts.input);
            child.stdin?.end();
        }
    });
}
