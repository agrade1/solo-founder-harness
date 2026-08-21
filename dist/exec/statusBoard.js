const LABEL = {
    coding: "코딩",
    gate: "게이트",
    review: "리뷰",
    merging: "병합",
    merged: "완료",
    deferred: "보류",
    failed: "실패",
};
const ICON = {
    coding: "⋯",
    gate: "▣",
    review: "◎",
    merging: "⤵",
    merged: "✓",
    deferred: "⏸",
    failed: "✗",
};
export class StatusBoard {
    rows = new Map();
    order = [];
    tty = Boolean(process.stdout.isTTY);
    linesRendered = 0;
    constructor(taskIds = []) {
        for (const id of taskIds) {
            this.rows.set(id, { taskId: id, phase: "coding", detail: "대기" });
            this.order.push(id);
        }
        if (this.order.length)
            this.render();
    }
    /** 세션 단계 갱신. */
    update(taskId, phase, detail = "") {
        const row = this.rows.get(taskId) ?? { taskId, phase, detail };
        row.phase = phase;
        row.detail = detail;
        this.rows.set(taskId, row);
        if (!this.order.includes(taskId))
            this.order.push(taskId);
        if (this.tty)
            this.render();
        else
            console.log(`  ${ICON[phase]} [${taskId}] ${LABEL[phase]}${detail ? ` — ${detail}` : ""}`);
    }
    /** 상태판 아래에 안전하게 한 줄 남긴다(TTY에서 블록을 흩뜨리지 않음). */
    note(message) {
        if (!this.tty) {
            console.log(message);
            return;
        }
        this.clear();
        process.stdout.write(message + "\n");
        this.render();
    }
    /** 상태판 렌더 종료(커서를 블록 아래로). */
    done() {
        if (this.tty)
            this.linesRendered = 0;
    }
    lineFor(r) {
        return `  ${ICON[r.phase]} ${r.taskId.padEnd(22)} ${LABEL[r.phase]}${r.detail ? ` — ${r.detail}` : ""}`;
    }
    clear() {
        if (this.linesRendered > 0) {
            process.stdout.write(`\x1b[${this.linesRendered}A`); // 블록 맨 위로
            process.stdout.write("\x1b[0J"); // 아래 전부 지움
            this.linesRendered = 0;
        }
    }
    render() {
        this.clear();
        let out = "";
        for (const id of this.order)
            out += this.lineFor(this.rows.get(id)) + "\n";
        process.stdout.write(out);
        this.linesRendered = this.order.length;
    }
}
