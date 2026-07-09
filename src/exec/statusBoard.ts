/**
 * 다중 세션 상태판 (ARCH §5 StatusBoard, ProgressReporter 일반화).
 * 병렬 미션에서 세션들의 로그가 뒤섞여 안 보이던 문제 해결 — 세션당 한 줄로 현재 단계를 보여준다.
 * TTY면 블록을 제자리 갱신, 비TTY(파이프/로그)면 전이만 한 줄씩 출력.
 */
export type BoardPhase = "coding" | "gate" | "review" | "merging" | "merged" | "deferred" | "failed";

const LABEL: Record<BoardPhase, string> = {
  coding: "코딩",
  gate: "게이트",
  review: "리뷰",
  merging: "병합",
  merged: "완료",
  deferred: "보류",
  failed: "실패",
};
const ICON: Record<BoardPhase, string> = {
  coding: "⋯",
  gate: "▣",
  review: "◎",
  merging: "⤵",
  merged: "✓",
  deferred: "⏸",
  failed: "✗",
};

interface Row {
  taskId: string;
  phase: BoardPhase;
  detail: string;
}

export class StatusBoard {
  private rows = new Map<string, Row>();
  private order: string[] = [];
  private tty = Boolean(process.stdout.isTTY);
  private linesRendered = 0;

  constructor(taskIds: string[] = []) {
    for (const id of taskIds) {
      this.rows.set(id, { taskId: id, phase: "coding", detail: "대기" });
      this.order.push(id);
    }
    if (this.order.length) this.render();
  }

  /** 세션 단계 갱신. */
  update(taskId: string, phase: BoardPhase, detail = ""): void {
    const row = this.rows.get(taskId) ?? { taskId, phase, detail };
    row.phase = phase;
    row.detail = detail;
    this.rows.set(taskId, row);
    if (!this.order.includes(taskId)) this.order.push(taskId);
    if (this.tty) this.render();
    else console.log(`  ${ICON[phase]} [${taskId}] ${LABEL[phase]}${detail ? ` — ${detail}` : ""}`);
  }

  /** 상태판 아래에 안전하게 한 줄 남긴다(TTY에서 블록을 흩뜨리지 않음). */
  note(message: string): void {
    if (!this.tty) {
      console.log(message);
      return;
    }
    this.clear();
    process.stdout.write(message + "\n");
    this.render();
  }

  /** 상태판 렌더 종료(커서를 블록 아래로). */
  done(): void {
    if (this.tty) this.linesRendered = 0;
  }

  private lineFor(r: Row): string {
    return `  ${ICON[r.phase]} ${r.taskId.padEnd(22)} ${LABEL[r.phase]}${r.detail ? ` — ${r.detail}` : ""}`;
  }

  private clear(): void {
    if (this.linesRendered > 0) {
      process.stdout.write(`\x1b[${this.linesRendered}A`); // 블록 맨 위로
      process.stdout.write("\x1b[0J"); // 아래 전부 지움
      this.linesRendered = 0;
    }
  }

  private render(): void {
    this.clear();
    let out = "";
    for (const id of this.order) out += this.lineFor(this.rows.get(id)!) + "\n";
    process.stdout.write(out);
    this.linesRendered = this.order.length;
  }
}
