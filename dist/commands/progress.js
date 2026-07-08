/**
 * 터미널 진행 상황 표시자.
 * - TTY: 한 줄에서 스피너 프레임 + 경과시간을 갱신 (\r로 제자리 갱신)
 * - 비 TTY (파이프/로그 리다이렉트): 애니메이션 없이 시작 줄 한 줄만 출력
 * 외부 패키지 의존 없음.
 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 100;
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
    return {
        start(l) {
            label = l;
            startedAt = Date.now();
            frame = 0;
            if (!tty) {
                process.stdout.write(`  ▶ ${label} 실행 중…\n`);
                return;
            }
            draw();
            timer = setInterval(draw, TICK_MS);
        },
        stop() {
            kill();
            if (tty)
                clear();
        },
        note(message) {
            const running = timer !== null;
            kill();
            if (tty)
                clear();
            process.stdout.write(message + "\n");
            if (running && tty) {
                draw();
                timer = setInterval(draw, TICK_MS);
            }
        },
    };
}
