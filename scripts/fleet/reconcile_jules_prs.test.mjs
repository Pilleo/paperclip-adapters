import assert from "node:assert/strict";
import test from "node:test";
import { buildReconciliationPlan, isReadyPullRequest } from "./reconcile_jules_prs.mjs";

const readyPr = {
  state: "OPEN", isDraft: false, mergeable: "MERGEABLE",
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
};

test("requires an open, mergeable PR with completed successful checks", () => {
  assert.equal(isReadyPullRequest(readyPr), true);
  assert.equal(isReadyPullRequest({ ...readyPr, mergeable: "CONFLICTING" }), false);
  assert.equal(isReadyPullRequest({ ...readyPr, statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: null }] }), false);
});

test("closes only source-linked productivity and compatibility blockers before review", () => {
  const source = { id: "source", status: "blocked" };
  const productivity = { id: "productivity", status: "todo", originKind: "issue_productivity_review", originId: "source" };
  const supervisor = { id: "supervisor", status: "todo", parentId: "source", description: "<!-- jules-session-supervisor:1 -->" };
  const unrelated = { id: "unrelated", status: "todo", originKind: "issue_productivity_review", originId: "other" };
  const details = new Map([["source", {
    documentSummaries: [{ key: "jules-session" }],
    workProducts: [{ type: "pull_request", url: "https://example.test/pr/1", metadata: { source: "jules" } }],
  }]]);
  const plan = buildReconciliationPlan([source, productivity, supervisor, unrelated], details, new Map([["https://example.test/pr/1", readyPr]]));
  assert.equal(plan.length, 1);
  assert.deepEqual(new Set(plan[0].completeIssueIds), new Set(["productivity", "supervisor"]));
  assert.equal(plan[0].transitionToReview, true);
});

test("does not transition a PR that is not ready", () => {
  const source = { id: "source", status: "blocked" };
  const details = new Map([["source", {
    documentSummaries: [{ key: "jules-session" }],
    workProducts: [{ type: "pull_request", url: "https://example.test/pr/1", metadata: { source: "jules" } }],
  }]]);
  const plan = buildReconciliationPlan([source], details, new Map([["https://example.test/pr/1", { ...readyPr, isDraft: true }]]));
  assert.deepEqual(plan, []);
});
