import { describe, it, expect } from "vitest";
import {
  buildMazewallExecutionPolicy,
  issueHasExecutionPolicy,
  issueNeedsExecutionPolicyBackfill,
} from "../src/core/execution-policy.js";

describe("mazewall execution policy builder", () => {
  it("builds vibe then strong review stages without a fake merge type", () => {
    const policy = buildMazewallExecutionPolicy({
      vibeAgentId: "vibe-1",
      reviewerAgentId: "rev-1",
    });
    expect(policy?.stages).toHaveLength(2);
    expect(policy?.stages[0]).toEqual({
      type: "review",
      participants: [{ type: "agent", agentId: "vibe-1" }],
    });
    expect(policy?.stages[1]?.type).toBe("review");
  });

  it("detects an existing Paperclip executionPolicy", () => {
    expect(issueHasExecutionPolicy({ executionPolicy: { stages: [{ type: "review" }] } })).toBe(true);
    expect(issueHasExecutionPolicy({})).toBe(false);
  });

  it("selects managed in_progress issues that skipped dispatch", () => {
    const managed = new Set(["jules-1"]);
    expect(
      issueNeedsExecutionPolicyBackfill(
        {
          status: "in_progress",
          assigneeAgentId: "jules-1",
          rawIssue: {},
        },
        managed,
      ),
    ).toBe(true);
    expect(
      issueNeedsExecutionPolicyBackfill(
        {
          status: "in_progress",
          assigneeAgentId: "jules-1",
          rawIssue: { executionPolicy: { stages: [{ type: "review" }] } },
        },
        managed,
      ),
    ).toBe(false);
    expect(
      issueNeedsExecutionPolicyBackfill(
        {
          status: "backlog",
          assigneeAgentId: "jules-1",
          rawIssue: {},
        },
        managed,
      ),
    ).toBe(false);
    expect(
      issueNeedsExecutionPolicyBackfill(
        {
          status: "in_progress",
          assigneeAgentId: "indie-jules",
          rawIssue: {},
        },
        managed,
      ),
    ).toBe(false);
  });
});
