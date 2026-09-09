import { describe, expect, it } from "vitest";
import { projectRecoveryCanaryState } from "../src/core/recovery-canary-state.js";

describe("projectRecoveryCanaryState", () => {
  it("compares durable review semantics while ignoring activity and timestamp churn", () => {
    const first = projectRecoveryCanaryState({
      issue: { status: "in_review", assigneeAgentId: null, updatedAt: "first", lastActivityAt: "first" },
      children: [
        { id: "child-b", status: "done", parentId: "parent", updatedAt: "first", completedAt: "first" },
        { id: "child-a", status: "done", parentId: "parent", statusVersion: 1 },
      ],
      interactions: [{ id: "card-luna", kind: "request_item_verdicts", status: "pending", idempotencyKey: "pr-review:luna", addresseeAgentId: "luna", createdAt: "first" }],
      workProducts: [],
      approvals: [],
      heartbeatRuns: [],
    });
    const second = projectRecoveryCanaryState({
      issue: { status: "in_review", assigneeAgentId: null, updatedAt: "second", lastActivityAt: "second", statusVersion: 99 },
      children: [
        { id: "child-a", status: "done", parentId: "parent", statusVersion: 2 },
        { id: "child-b", status: "done", parentId: "parent", updatedAt: "second", completedAt: "second" },
      ],
      interactions: [{ id: "card-luna", kind: "request_item_verdicts", status: "pending", idempotencyKey: "pr-review:luna", addresseeAgentId: "luna", createdAt: "second" }],
      workProducts: [],
      approvals: [],
      heartbeatRuns: [],
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
      workProducts: [],
      approvals: [],
      heartbeatRuns: [],
    })).toEqual({
      parent: { status: "in_review", assigneeAgentId: null },
      children: [{ id: "child-a", status: "todo", parentId: "parent" }],
      pendingCards: [
        { id: "one", idempotencyKey: "pr-review:luna", addresseeAgentId: "luna" },
        { id: "two", idempotencyKey: "pr-review:luna:attempt:2", addresseeAgentId: "luna" },
      ],
      workProducts: [],
      approvals: [],
      heartbeatRuns: [],
    });
  });

  it("retains work products, approvals, and relevant runs in the idempotency contract", () => {
    const base = {
      issue: { status: "in_review", assigneeAgentId: "luna" },
      children: [],
      interactions: [],
      workProducts: [{ id: "pr", status: "ready_for_review", externalId: "https://example.test/pr/1" }],
      approvals: [{ id: "merge", status: "pending" }],
      heartbeatRuns: [{ id: "recovery", status: "succeeded" }],
    };

    const expected = projectRecoveryCanaryState(base);
    expect(projectRecoveryCanaryState({ ...base, workProducts: [{ ...base.workProducts[0], status: "failed" }] })).not.toEqual(expected);
    expect(projectRecoveryCanaryState({ ...base, approvals: [{ ...base.approvals[0], status: "approved" }] })).not.toEqual(expected);
    expect(projectRecoveryCanaryState({ ...base, heartbeatRuns: [{ ...base.heartbeatRuns[0], status: "failed" }] })).not.toEqual(expected);
  });
});
