import { createInterface } from "node:readline";
/**
 * [B-41/1단] stdin y/N 승인자 — **공유 모듈**. `run`과 `pipeline next`가 같은 함수를 쓴다
 * (승인자가 두 벌이면 한쪽만 정직해진다 — 이 레포가 gateOutcomeLabel에서 이미 겪은 부류다).
 *
 * `y`/`yes`만 승인이고 **그 밖의 모든 종료 경로는 거부(false)**다: EOF(파이프 끝·비TTY)·
 * stream close·error 어디서든 **정확히 한 번** resolve한다.
 *
 * 왜 "정확히 한 번"을 못 박는가:
 *  - `rl.question` 콜백 하나만 달면 비TTY/EOF에서 콜백이 아예 오지 않아 Promise가 영원히
 *    pending이다 — 승인 대기로 매달린 프로세스는 "승인됐다"도 "거부됐다"도 아니다.
 *  - close/error를 더하면 같은 Promise가 두 번 resolve될 수 있고(첫 값이 이기고 나머지는
 *    **조용히** 버려진다), 조용히 버려지는 경로는 나중에 "왜 승인된 걸로 보이지"로 자란다.
 * 그래서 settle 플래그로 한 번만 통과시킨다. 기본값은 항상 거부 쪽이다(fail closed).
 *
 * `show`는 받아서 **쓰지 않는다**: 검토 문서 본문은 호출자(runWorkflow)가 이미 출력했고,
 * 여기서 다시 적으면 기존 CLI 프롬프트 바이트가 바뀐다(회귀). 시그니처 호환용이다.
 */
export function stdinApprover(message, _show, 
/**
 * 테스트 seam(`providerOverride`·`now`와 같은 목적). 미지정 시 실제 stdin/stdout.
 * EOF·error 경로를 재려면 스트림을 주입할 수밖에 없다 — process.stdin으로는 test runner의
 * stdin을 소모하거나 매달릴 뿐이고, 그러면 "정확히 한 번 false"는 증명되지 않은 주장으로 남는다.
 */
io) {
    return new Promise((resolve) => {
        const rl = createInterface({ input: io?.input ?? process.stdin, output: io?.output ?? process.stdout });
        let settled = false;
        const settle = (v) => {
            if (settled)
                return;
            settled = true;
            rl.close();
            resolve(v);
        };
        rl.on("close", () => settle(false)); // EOF·stream 종료 = 승인 없음
        rl.on("error", () => settle(false));
        rl.question(`\n[승인 필요] ${message} (y/N): `, (ans) => settle(/^y(es)?$/i.test(ans.trim())));
    });
}
