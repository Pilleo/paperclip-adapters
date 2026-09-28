import { describe, expect, it } from "vitest";
import { projectRecoveryCanaryState, classifyRecoveryCanaryParentHold } from "../src/core/recovery-canary-state.js";

describe("projectRecoveryCanaryState", () => {
  it("compares durable review semantics while ignoring activity and timestamp churn", () => {
    const first = projectRecoveryCanaryState({
      issue: { status: "in_review", assigneeAgentId: null, updatedAt: "first", lastActivityAt: "first" },
      children: [
        { id: "child-b", status: "done", parentId: "parent", updatedAt: "first", completedAt: "first" },
        { id: "child-a", status: "done", parentId: "parent", statusVersion: 1 },
      ],
      interactions: [{ id: "card-luna", kind: "request_item_verdicts", status: "pending", idempotencyKey: "pr-review:luna", addresseeAgentId: "luna", createdAt: "first" }],
    });
    const second = projectRecoveryCanaryState({
      issue: { status: "in_review", assigneeAgentId: null, updatedAt: "second", lastActivityAt: "second", statusVersion: 99 },
      children: [
        { id: "child-a", status: "done", parentId: "parent", statusVersion: 2 },
        { id: "child-b", status: "done", parentId: "parent", updatedAt: "second", completedAt: "second" },
      ],
      interactions: [{ id: "card-luna", kind: "request_item_verdicts", status: "pending", idempotencyKey: "pr-review:luna", addresseeAgentId: "luna", createdAt: "second" }],
    });

    expect(second).toEqual(first);
  });

  it("detects a duplicate card or a non-terminal stale child", () => {
    expect(projectRecoveryCanaryState({
      issue: { status: "in_review", assigneeAgentId: null },
      children: [{ id: "child-a", status: "todo", parentId: "parent" }],
      interactions: [
        { id: "one", kind: "request_item_verdicts", status: "pending", idempotencyKey: "pr-review:luna", addresseeAgentId: "luna" },
        { id: "two", kind: "request_item_verdicts", status: "pending", idempotencyKey: "pr-review:luna:attempt:2", addresseeAgentId: "luna" },
      ],
    })).toEqual({
      parent: { status: "in_review", assigneeAgentId: null },
      children: [{ id: "child-a", status: "todo", parentId: "parent" }],
      pendingCards: [
        { id: "one", idempotencyKey: "pr-review:luna", addresseeAgentId: "luna" },
        { id: "two", idempotencyKey: "pr-review:luna:attempt:2", addresseeAgentId: "luna" },
      ],
    });
  });
});

describe("classifyRecoveryCanaryParentHold", () => {
  const prUrl = "https://github.com/pilleo/paperclip-adapters/pull/991";
  const headSha = "a".repeat(40);
  const parentCard = { id: "original-card", kind: "request_item_verdicts", status: "pending",
    createdByAgentId: null, addresseeAgentId: "luna",
    idempotencyKey: `pr-review:v13:parent:${prUrl}:${headSha}:luna` };
  const planCard = { id: "stale-plan", kind: "request_item_verdicts", status: "pending",
    idempotencyKey: "jules:plan-review:v2:parent:session:revision:luna" };
  const input = { issue: { id: "parent", status: "in_review", assigneeAgentId: null,
      workProducts: [{ type: "pull_request", isPrimary: true, status: "ready_for_review", url: prUrl,
        metadata: { source: "jules", headSha } }] }, prUrl, headSha,
    reviewerAgentId: "luna", cards: [parentCard, planCard], reviewerRuns: [], children: [] };

  it("recognizes the preserved parent-card authority lock rather than successful review", () => {
    expect(classifyRecoveryCanaryParentHold(input)).toEqual({ kind: "board_disposition_required",
      parentCardId: "original-card", stalePlanCardId: "stale-plan" });
  });

  it("refuses to call a changed-head, duplicate or active-reviewer card an idle hold", () => {
    expect(classifyRecoveryCanaryParentHold({ ...input, headSha: "b".repeat(40) })).toEqual({ kind: "not_qualified" });
    expect(classifyRecoveryCanaryParentHold({ ...input, cards: [parentCard, parentCard, planCard] })).toEqual({ kind: "not_qualified" });
    expect(classifyRecoveryCanaryParentHold({ ...input, issue: { ...input.issue, workProducts: [] } })).toEqual({ kind: "not_qualified" });
    expect(classifyRecoveryCanaryParentHold({ ...input, reviewerRuns: [{ agentId: "luna", status: "running", issueId: "parent" }] }))
      .toEqual({ kind: "not_qualified" });
  });
});
