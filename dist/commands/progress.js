/**
 * 터미널 진행 상황 렌더러 (이벤트 소비자).
 * runWorkflow가 방출하는 RunEvent를 받아 그린다.
 * - TTY: LLM 호출 step 동안 한 줄 스피너+경과시간을 \r로 제자리 갱신
 * - 비 TTY (파이프/로그): 애니메이션 없이 시작 줄 한 줄만 출력
 * 외부 패키지 의존 없음. 완료 "✓" 라인·게이트/승인 라인은 core가 console.log로 직접 출력한다.
 *
 * 스피너는 장시간 LLM 호출 step(agent/critic/revise/spawn)에서만 돈다.
 * gate/approval은 즉시 처리되거나 stdin(승인 프롬프트)을 기다리므로 스피너를 띄우지 않는다
 * — \r 갱신과 readline 프롬프트 충돌 방지 (F2.2).
 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 100;
const SPIN_KINDS = new Set(["agent", "critic", "revise", "spawn"]);
function fmt(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60)
        return `${s}s`;
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
export function createProgressReporter() {
    const tty = Boolean(process.stdout.isTTY);
    let timer = null;
    let frame = 0;
    let startedAt = 0;
    let label = "";
    const draw = () => {
        const line = `  ${FRAMES[frame]} ${label} 실행 중… ${fmt(Date.now() - startedAt)}`;
        process.stdout.write(`\r\x1b[2K${line}`); // \r: 줄 앞으로, \x1b[2K: 줄 전체 지움
        frame = (frame + 1) % FRAMES.length;
    };
    const clear = () => process.stdout.write("\r\x1b[2K");
    const kill = () => {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    };
    const startSpinner = (l) => {
        label = l;
        startedAt = Date.now();
        frame = 0;
        if (!tty) {
            process.stdout.write(`  ▶ ${label} 실행 중…\n`);
            return;
        }
        draw();
        timer = setInterval(draw, TICK_MS);
    };
    const stopSpinner = () => {
        kill();
        if (tty)
            clear();
    };
    const note = (message) => {
        const running = timer !== null;
        kill();
        if (tty)
            clear();
        process.stdout.write(message + "\n");
        if (running && tty) {
            draw();
            timer = setInterval(draw, TICK_MS);
        }
    };
    return {
        emit(e) {
            switch (e.type) {
                case "step_start":
                    if (SPIN_KINDS.has(e.kind))
                        startSpinner(e.label ?? `[${e.index}/${e.total}] ${e.agentId}`);
                    break;
                case "step_end":
                    if (SPIN_KINDS.has(e.kind))
                        stopSpinner();
                    break;
                case "note":
                    note(e.message);
                    break;
                case "run_end":
                    kill(); // 정리 안전망: 예외 등으로 스피너가 남아있으면 확실히 멈춘다
                    break;
                // run_start / gate_jump / tool_* : core가 직접 로그 출력하거나 M1에서 방출 없음 — no-op
                default:
                    break;
            }
        },
    };
}
