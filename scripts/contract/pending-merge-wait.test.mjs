import assert from "node:assert/strict";
import test from "node:test";
import { assertPendingMergeWait } from "../../packages/orchestrator/test/contract/pending-merge-wait.mjs";

const expected = { issueId: "source", approvalId: "original-gate", prUrl: "https://github.com/fixture/repo/pull/1",
  headSha: "a".repeat(40), productId: "product", cardIds: ["plan-luna", "plan-strong", "pr-luna", "pr-strong"] };
const snapshot = () => ({ issue: { id: "source", status: "in_review" }, approvals: [{ id: "original-gate", status: "pending",
  payload: { action: "task_merge", issueId: "source", prUrl: expected.prUrl } }],
  products: [{ id: "product", url: expected.prUrl, status: "ready_for_review", metadata: { headSha: expected.headSha } }],
  cards: expected.cardIds.map((id) => ({ id, status: "answered" })) });

test("pending native merge evidence is classified as a human wait", () => {
  assert.deepEqual(assertPendingMergeWait(snapshot(), expected), { kind: "awaiting_user_merge" });
});

test("retired question recovery cards remain immutable history without weakening native review verdicts", () => {
  const state = snapshot();
  state.cards.push({ id: "retired-question", kind: "ask_user_questions", status: "cancelled" });
  const withQuestion = { ...expected, cardIds: [...expected.cardIds, "retired-question"], questionCardStates: { "retired-question": "cancelled" } };
  assert.deepEqual(assertPendingMergeWait(state, withQuestion), { kind: "awaiting_user_merge" });
  state.cards.at(-1).kind = "request_item_verdicts";
  assert.throws(() => assertPendingMergeWait(state, withQuestion));
});

test("cancelled and replaced human gate cannot pass as restart persistence", () => {
  const state = snapshot();
  state.approvals[0].status = "cancelled";
  state.approvals.push({ ...state.approvals[0], id: "replacement-gate", status: "pending" });
  assert.throws(() => assertPendingMergeWait(state, expected));
});

test("duplicate reviews, premature completion and changed PR head fail the wait invariant", () => {
  for (const corrupt of [
    (state) => state.cards.push({ id: "replacement-review", status: "answered" }),
    (state) => { state.issue.status = "done"; },
    (state) => { state.products[0].metadata.headSha = "b".repeat(40); },
  ]) {
    const state = snapshot();
    corrupt(state);
    assert.throws(() => assertPendingMergeWait(state, expected));
  }
});
