/**
 * 승인 직렬화 큐 (ARCH §0 ApprovalQueue, §4.3 사람 접점).
 * 병행 세션이 동시에 승인을 요청해도 사람에게는 한 번에 하나씩만 묻는다(FIFO).
 * 결정은 approve/reject/defer — defer는 T2 보류 목록(ARCH §4.2)으로.
 *
 * approver는 주입: 대화형=stdin, 미션 모드=사전승인 규칙, 테스트=스크립트.
 */
export type Decision = "approve" | "reject" | "defer";

export interface ApprovalRequest {
  sessionId: string;
  kind: string; // 예: "diff-merge", "t2-dependency", "spawn"
  message: string;
  detail?: string; // diff 요약 등 부가 표시
}

/** 실제 결정을 내리는 함수. 큐가 직렬화해서 한 번에 하나만 호출한다. */
export type Approver = (req: ApprovalRequest) => Promise<Decision>;

export class ApprovalQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private deferred: ApprovalRequest[] = [];

  constructor(private approver: Approver) {}

  /** 승인 요청. 앞선 요청이 끝난 뒤에야 이 요청의 approver가 호출된다(직렬화). */
  request(req: ApprovalRequest): Promise<Decision> {
    const result = this.chain.then(() => this.approver(req));
    // 다음 요청이 이 요청 완료 후 실행되도록 체인 연장 (실패해도 체인은 이어감)
    this.chain = result.then(
      (d) => {
        if (d === "defer") this.deferred.push(req);
      },
      () => undefined,
    );
    return result;
  }

  /** 지금까지 defer된 요청들 (미션 종료 시 보류 목록 → 사람이 아침에 결정). */
  deferredList(): ApprovalRequest[] {
    return [...this.deferred];
  }
}

/** 모든 요청을 자동 승인(미션 사전승인 범위·테스트용). */
export const autoApprove: Approver = async () => "approve";
