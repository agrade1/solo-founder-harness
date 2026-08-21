export class ApprovalQueue {
    approver;
    chain = Promise.resolve();
    deferred = [];
    constructor(approver) {
        this.approver = approver;
    }
    /** 승인 요청. 앞선 요청이 끝난 뒤에야 이 요청의 approver가 호출된다(직렬화). */
    request(req) {
        const result = this.chain.then(() => this.approver(req));
        // 다음 요청이 이 요청 완료 후 실행되도록 체인 연장 (실패해도 체인은 이어감)
        this.chain = result.then((d) => {
            if (d === "defer")
                this.deferred.push(req);
        }, () => undefined);
        return result;
    }
    /** 지금까지 defer된 요청들 (미션 종료 시 보류 목록 → 사람이 아침에 결정). */
    deferredList() {
        return [...this.deferred];
    }
}
/** 모든 요청을 자동 승인(미션 사전승인 범위·테스트용). */
export const autoApprove = async () => "approve";
