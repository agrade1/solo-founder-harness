/**
 * push 기반 비동기 큐. 생산자가 push()/close()로 이벤트를 넣고,
 * 소비자는 for-await로 소진한다. provider의 events() 구현 공유용.
 */
export class AsyncEventQueue {
    queue = [];
    resolvers = [];
    closed = false;
    push(item) {
        if (this.closed)
            return;
        const r = this.resolvers.shift();
        if (r)
            r({ value: item, done: false });
        else
            this.queue.push(item);
    }
    /** 더 이상 이벤트 없음. 대기 중인 소비자들을 종료시킨다. */
    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const r of this.resolvers)
            r({ value: undefined, done: true });
        this.resolvers = [];
    }
    [Symbol.asyncIterator]() {
        return {
            next: () => {
                if (this.queue.length > 0) {
                    return Promise.resolve({ value: this.queue.shift(), done: false });
                }
                if (this.closed)
                    return Promise.resolve({ value: undefined, done: true });
                return new Promise((resolve) => this.resolvers.push(resolve));
            },
        };
    }
}
