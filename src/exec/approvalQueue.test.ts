/**
 * ApprovalQueue 테스트 (무과금). 직렬화·defer 목록 검증.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalQueue, autoApprove, type ApprovalRequest, type Decision } from "./approvalQueue.js";

function req(id: string, kind = "diff-merge"): ApprovalRequest {
  return { sessionId: id, kind, message: `승인? ${id}` };
}

test("동시 요청도 한 번에 하나씩 직렬 처리", async () => {
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const q = new ApprovalQueue(async (r) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((res) => setTimeout(res, 5));
    order.push(r.sessionId);
    active--;
    return "approve" as Decision;
  });
  await Promise.all([q.request(req("a")), q.request(req("b")), q.request(req("c"))]);
  assert.equal(maxActive, 1, "동시 실행 approver 최대 1");
  assert.deepEqual(order, ["a", "b", "c"], "FIFO 순서");
});

test("defer된 요청은 deferredList에 쌓임", async () => {
  const q = new ApprovalQueue(async (r) => (r.sessionId === "x" ? "defer" : "approve"));
  await q.request(req("a"));
  await q.request(req("x"));
  await q.request(req("y"));
  const d = q.deferredList();
  assert.equal(d.length, 1);
  assert.equal(d[0].sessionId, "x");
});

test("approver가 throw해도 체인은 이어짐", async () => {
  let calls = 0;
  const q = new ApprovalQueue(async () => {
    calls++;
    if (calls === 1) throw new Error("boom");
    return "approve";
  });
  await assert.rejects(q.request(req("a")));
  const d = await q.request(req("b"));
  assert.equal(d, "approve");
});

test("autoApprove는 항상 approve", async () => {
  const q = new ApprovalQueue(autoApprove);
  assert.equal(await q.request(req("a")), "approve");
});
