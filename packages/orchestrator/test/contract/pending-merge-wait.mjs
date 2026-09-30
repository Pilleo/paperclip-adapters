import assert from "node:assert/strict";

/** Grade native read-only evidence; a replacement card is not restart persistence. */
export function assertPendingMergeWait(snapshot, expected) {
  assert.equal(snapshot.issue.id, expected.issueId);
  assert.equal(snapshot.issue.status, "in_review");
  const gates = snapshot.approvals.filter((approval) => approval.payload?.action === "task_merge" &&
    approval.payload.issueId === expected.issueId);
  assert.equal(gates.length, 1, "human wait must retain exactly one original merge gate");
  assert.equal(gates[0].id, expected.approvalId);
  assert.equal(gates[0].status, "pending");
  assert.equal(gates[0].payload.prUrl, expected.prUrl);
  assert.equal(snapshot.products.length, 1);
  assert.equal(snapshot.products[0].id, expected.productId);
  assert.equal(snapshot.products[0].url, expected.prUrl);
  assert.equal(snapshot.products[0].metadata?.headSha, expected.headSha);
  assert.notEqual(snapshot.products[0].status, "merged");
  assert.deepEqual(snapshot.cards.map((card) => card.id).sort(), [...expected.cardIds].sort());
  assert.ok(snapshot.cards.every((card) => card.status === "answered"));
  return { kind: "awaiting_user_merge" };
}
