import { describe, it, expect } from "vitest";
import {
  buildMazewallExecutionPolicy,
  issueHasExecutionPolicy,
  issueHasUnsafeVibeReviewParticipant,
  issueNeedsExecutionPolicyBackfill,
  isMergedPrTerminalProjection,
  isNativePrReviewHandoffProjection,
  mergedPrTerminalPatch,
  nativeManagedExecutionDispatchPatch,
  nativePrReviewCleanupPatch,
  nativePrReviewOwnershipPatch,
  nativePrReviewParticipantPatch,
  nativePrReviewWaitPatch,
  requiresMergedPrTerminalOwnershipCleanup,
  shouldTakeOverNativePrReview,
  shouldRecoverNativePrReview,
} from "../src/core/execution-policy.js";

describe("mazewall execution policy builder", () => {
  it("builds read-only Vibe then strong review stages without a fake merge type", () => {
    const policy = buildMazewallExecutionPolicy({
      vibeReviewerAgentId: "vibe-review-1",
      reviewerAgentId: "rev-1",
    });
    expect(policy?.stages).toHaveLength(2);
    expect(policy?.stages[0]).toEqual({
      type: "review",
      participants: [{ type: "agent", agentId: "vibe-review-1" }],
    });
    expect(policy?.stages[1]?.type).toBe("review");
  });

  it("identifies only the legacy writable Vibe review participant for migration", () => {
    expect(issueHasUnsafeVibeReviewParticipant({
      executionPolicy: { stages: [{ type: "review", participants: [{ type: "agent", agentId: "vibe-dev" }] }] },
    }, "vibe-dev")).toBe(true);
    expect(issueHasUnsafeVibeReviewParticipant({
      executionPolicy: { stages: [{ type: "review", participants: [{ type: "agent", agentId: "vibe-review" }] }] },
    }, "vibe-dev")).toBe(false);
  });

  it("detects an existing Paperclip executionPolicy", () => {
    expect(issueHasExecutionPolicy({ executionPolicy: { stages: [{ type: "review" }] } })).toBe(true);
    expect(issueHasExecutionPolicy({})).toBe(false);
  });

  it("clears Paperclip reviewer execution before adapter-owned PR review", () => {
    expect(nativePrReviewCleanupPatch()).toEqual({
      status: "in_review",
      assigneeAgentId: null,
      executionPolicy: null,
      executionState: null,
    });
  });

  it.each([
    ["accepts a fully cleared native review handoff", { status: "in_review", assigneeAgentId: null, executionPolicy: null, executionState: null }, true],
    ["accepts an inert normalized Paperclip state", { status: "in_review", assigneeAgentId: null, executionPolicy: null, executionState: { status: "idle", monitor: { status: "cleared" } } }, true],
    ["rejects residual Jules ownership", { status: "in_review", assigneeAgentId: "jules-1", executionPolicy: null, executionState: null }, false],
    ["rejects a scheduled provider monitor", { status: "in_review", assigneeAgentId: null, executionPolicy: null, executionState: { status: "idle", monitor: { status: "scheduled", serviceName: "jules" } } }, false],
    ["rejects a triggered provider monitor without terminal producer evidence", { status: "in_review", assigneeAgentId: null, executionPolicy: null, executionState: { status: "idle", monitor: { status: "triggered", serviceName: "jules" } } }, false],
  ] as const)("%s", (_name, issue, expected) => {
    expect(isNativePrReviewHandoffProjection(issue)).toBe(expected);
  });

  it("accepts Paperclip's retained triggered Jules monitor only with terminal producer evidence", () => {
    const retainedProviderTelemetry = {
      status: "in_review",
      assigneeAgentId: null,
      executionPolicy: null,
      executionState: { status: "idle", monitor: { status: "triggered", serviceName: "jules" } },
    };

    expect(isNativePrReviewHandoffProjection(retainedProviderTelemetry, { terminalJulesProducer: true })).toBe(true);
  });

  it("clears every host-owned execution field when a registered PR is merged", () => {
    expect(mergedPrTerminalPatch()).toEqual({
      status: "done",
      assigneeAgentId: null,
      executionPolicy: null,
      executionState: null,
    });
  });

  it("starts managed implementation without installing a host review policy", () => {
    expect(nativeManagedExecutionDispatchPatch("jules-1")).toEqual({
      status: "in_progress",
      assigneeAgentId: "jules-1",
      executionPolicy: null,
      executionState: null,
    });
  });

  it.each([
    ["accepts a fully cleared terminal projection", { status: "done", assigneeAgentId: null, executionPolicy: null, executionState: null }, true],
    ["accepts Paperclip's normalized idle state with a cleared external monitor", {
      status: "done",
      assigneeAgentId: null,
      executionPolicy: null,
      executionState: {
        status: "idle",
        monitor: { kind: "external_service", status: "cleared", serviceName: "jules" },
        reviewRequest: null,
        currentStageId: null,
        currentStageType: null,
        currentStageIndex: null,
        currentParticipant: null,
      },
    }, true],
    ["rejects a done status that still has a host policy", { status: "done", assigneeAgentId: null, executionPolicy: { stages: [] }, executionState: null }, false],
    ["rejects a done status that still has host execution state", { status: "done", assigneeAgentId: null, executionPolicy: null, executionState: { status: "pending" } }, false],
  ] as const)("%s", (_name, issue, expected) => {
    expect(isMergedPrTerminalProjection(issue)).toBe(expected);
  });

  it.each([
    ["cleans a blocked task with a host reviewer policy", {
      status: "blocked", assigneeAgentId: "luna-1", executionPolicy: { stages: [{ type: "review" }] }, executionState: { status: "pending", currentParticipant: { type: "agent", agentId: "luna-1" } },
    }, true],
    ["cleans a done task that still names an assignee", {
      status: "done", assigneeAgentId: "jules-1", executionPolicy: null, executionState: { status: "idle", monitor: { status: "cleared" } },
    }, true],
    ["does not rewrite a done task with only inert cleared monitor history", {
      status: "done", assigneeAgentId: null, executionPolicy: null, executionState: { status: "idle", monitor: { status: "cleared" }, currentParticipant: null, reviewRequest: null },
    }, false],
    ["does not rewrite a fully absent execution projection", {
      status: "done", assigneeAgentId: null, executionPolicy: null, executionState: null,
    }, false],
  ] as const)("%s", (_name, issue, expected) => {
    expect(requiresMergedPrTerminalOwnershipCleanup(issue)).toBe(expected);
  });

  it.each([
    ["takes over a host review policy for a managed ready PR", {
      orchestratorManaged: true,
      hasReadyPullRequest: true,
      nativeReviewConfigured: true,
      rawIssue: { executionPolicy: { stages: [{ type: "review" }] } },
    }, true],
    ["does not take over before a PR exists", {
      orchestratorManaged: true,
      hasReadyPullRequest: false,
      nativeReviewConfigured: true,
      rawIssue: { executionPolicy: { stages: [{ type: "review" }] } },
    }, false],
    ["does not take over an operator policy without the native ladder", {
      orchestratorManaged: true,
      hasReadyPullRequest: true,
      nativeReviewConfigured: false,
      rawIssue: { executionPolicy: { stages: [{ type: "review" }] } },
    }, false],
    ["does not repeat a completed ownership transfer", {
      orchestratorManaged: true,
      hasReadyPullRequest: true,
      nativeReviewConfigured: true,
      rawIssue: { executionPolicy: null },
    }, false],
  ] as const)("%s", (_name, input, expected) => {
    expect(shouldTakeOverNativePrReview(input)).toBe(expected);
  });

  it("keeps an unavailable review owned and visible", () => {
    expect(nativePrReviewWaitPatch("orch-1", { status: "waiting_for_reviewer" })).toEqual({ status: "in_review", assigneeAgentId: "orch-1", executionPolicy: null, executionState: { status: "waiting_for_reviewer" } });
  });

  it("assigns an active native review to its addressed reviewer without a host review policy", () => {
    expect(nativePrReviewOwnershipPatch("luna-1")).toEqual({
      status: "in_review",
      assigneeAgentId: "luna-1",
      executionPolicy: null,
      executionState: null,
    });
  });

  it("keeps adapter-owned review execution with the orchestrator", () => {
    expect(nativePrReviewParticipantPatch("orch-1", "luna-1", { status: "pending", currentParticipant: { type: "agent", agentId: "luna-1" } })).toEqual({
      status: "in_review",
      assigneeAgentId: "orch-1",
      executionPolicy: null,
      executionState: { status: "pending", currentParticipant: { type: "agent", agentId: "luna-1" } },
    });
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
          status: "in_progress",
          assigneeAgentId: "jules-1",
          hasReadyPullRequest: true,
          rawIssue: {},
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

  it.each([
    ["blocked", true],
    ["backlog", true],
    ["todo", true],
    ["done", true],
    ["in_progress", false],
    ["in_review", false],
  ])("recovers an unreviewed ready PR from %s only when the review lane is terminal", (status, expected) => {
    expect(shouldRecoverNativePrReview({
      status,
      orchestratorManaged: true,
      merged: false,
      hasUnreviewedReadyPullRequest: true,
      ciGreen: true,
    })).toBe(expected);
  });

  it("does not recover a ready PR into review while its CI gate is red", () => {
    expect(shouldRecoverNativePrReview({
      status: "backlog",
      orchestratorManaged: true,
      merged: false,
      hasUnreviewedReadyPullRequest: true,
      ciGreen: false,
    })).toBe(false);
  });
});
