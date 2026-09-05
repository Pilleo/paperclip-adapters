import { describe, expect, it } from "vitest";
import { classifyReviewPipelineAction, evaluateReviewPipelineProgress, hasStaleReviewerOwnership, operatorGateReconciliationPatch, type ReviewPipelineParams } from "../src/core/review-pipeline.js";
import { reviewInteractionIdempotencyKey } from "../src/core/review-interaction-state.js";
import type { ParsedIssueMetadata } from "../src/core/types.js";

describe("native multi-tier review pipeline", () => {
  it.each([
    ["AWAIT_CI", "ci"],
    ["AWAIT_REVIEW", "wait"],
    ["AWAIT_OPERATOR_APPROVAL", "wait"],
    ["DISPATCH_LUNA_REVIEW", "dispatch"],
    ["RECOVER_REVIEW", "dispatch"],
    ["REASSIGN_TO_WORKER", "mutation"],
    ["CREATE_MERGE_APPROVAL", "mutation"],
    ["EXECUTE_MERGE", "mutation"],
  ] as const)("classifies pipeline action %s exhaustively", (action, group) => {
    expect(classifyReviewPipelineAction(action)).toBe(group);
  });
  const issue: ParsedIssueMetadata = {
    id: "issue-141", identifier: "MAZ-141", title: "Review target", status: "in_review", priority: "high",
    priorityRank: 1, dependencies: [], targetFiles: [], targetModules: [], targetSymbols: [], hasSideEffects: false,
    coreLock: false, needsKernel: false, exclusive: false, verifyCheap: [], isNonInterfering: false,
    openQuestions: false, orchestratorManaged: true, rawIssue: {},
  };
  const interaction = (stage: "vibe" | "strong", verdict: "approve" | "reject", reason?: string) => ({
    id: `${stage}-${verdict}`,
    kind: "request_item_verdicts",
    status: "answered",
    idempotencyKey: reviewInteractionIdempotencyKey({ issueId: "issue-141", prUrl: "pr-526", headSha: "unknown", stage }),
    result: { items: [{ id: "pull_request", verdict, ...(reason ? { reason } : {}) }] },
  });
  const nativeCard = (stage: "luna" | "terra", status: "pending" | "expired" | "cancelled") => ({
    id: `${stage}-${status}`,
    kind: "request_item_verdicts",
    status,
    idempotencyKey: reviewInteractionIdempotencyKey({ issueId: "issue-141", prUrl: "pr-526", headSha: "unknown", stage }),
  });
  const base = (interactions: readonly ReturnType<typeof interaction>[] = []): ReviewPipelineParams => ({
    issue, prNumber: 526, ciStatus: { isGreen: true, status: "success" }, interactions,
    existingApprovals: [], vibeReviewerAgentId: "agent-vibe", reviewerAgentId: "agent-strong", workerAgentId: "agent-jules",
  });

  it("recognizes an answered card when only the PR URL spelling changed", () => {
    const p = base([]);
    const headSha = "abc123";
    const terraCard = {
      id: "terra-approved",
      kind: "request_item_verdicts",
      status: "answered",
      idempotencyKey: `pr-review:v12:${issue.id}:https://api.github.com/repos/acme/repo/pulls/526:${headSha}:terra`,
      result: { items: [{ id: "pull_request", verdict: "approve" }] },
    };
    const lunaCard = {
      id: "luna-approved",
      kind: "request_item_verdicts",
      status: "answered",
      idempotencyKey: reviewInteractionIdempotencyKey({ issueId: issue.id, prUrl: "pr-526", headSha, stage: "luna" }),
      result: { items: [{ id: "pull_request", verdict: "approve" }] },
    };
    expect(evaluateReviewPipelineProgress({
      ...p, prUrl: "pr-526", reviewHeadSha: headSha,
      lunaReviewerAgentId: "agent-luna", terraReviewerAgentId: "agent-terra",
      interactions: [lunaCard, terraCard],
    }).action).toBe("CREATE_MERGE_APPROVAL");
  });

  it("ignores an expired pre-version card before the answered migrated card", () => {
    const p = base([]);
    const headSha = "9d1b229fa0a9102c25b619b1bc5252f1b4851201";
    const staleLunaCard = {
      id: "luna-expired-v3",
      kind: "request_item_verdicts",
      status: "expired",
      idempotencyKey: `pr-review:v3:${issue.id}:https://api.github.com/repos/acme/repo/pulls/526:${headSha}:luna`,
    };
    const lunaCard = {
      id: "luna-approved-v12",
      kind: "request_item_verdicts",
      status: "answered",
      idempotencyKey: `pr-review:v12:${issue.id}:https://api.github.com/repos/acme/repo/pulls/526:${headSha}:luna`,
      result: { items: [{ id: "pull_request", verdict: "approve" }] },
    };
    const terraCard = {
      id: "terra-approved-v12",
      kind: "request_item_verdicts",
      status: "answered",
      idempotencyKey: `pr-review:v12:${issue.id}:https://api.github.com/repos/acme/repo/pulls/526:${headSha}:terra`,
      result: { items: [{ id: "pull_request", verdict: "approve" }] },
    };
    expect(evaluateReviewPipelineProgress({
      ...p, prUrl: "pr-526", reviewHeadSha: headSha,
      lunaReviewerAgentId: "agent-luna", terraReviewerAgentId: "agent-terra",
      interactions: [staleLunaCard, lunaCard, terraCard],
    }).action).toBe("CREATE_MERGE_APPROVAL");
  });

  it("waits for an existing merge approval after both native reviewers approve", () => {
    const p = base([]);
    const headSha = "9d1b229fa0a9102c25b619b1bc5252f1b4851201";
    const card = (stage: "luna" | "terra") => ({
      id: `${stage}-approved`,
      kind: "request_item_verdicts",
      status: "answered",
      idempotencyKey: `pr-review:v12:${issue.id}:https://github.com/Pilleo/paperclip-adapters/pull/3:${headSha}:${stage}`,
      result: { items: [{ id: "pull_request", verdict: "approve" }] },
    });
    const decision = evaluateReviewPipelineProgress({
      ...p,
      prNumber: 3,
      prUrl: "https://github.com/Pilleo/paperclip-adapters/pull/3",
      reviewHeadSha: headSha,
      lunaReviewerAgentId: "agent-luna",
      terraReviewerAgentId: "agent-terra",
      interactions: [card("luna"), card("terra")],
      existingApprovals: [{
        id: "merge-approval",
        type: "request_board_approval",
        status: "pending",
        issueIds: [],
        payload: { action: "task_merge", issueId: issue.id },
      }],
    });
    expect(decision).toMatchObject({ action: "AWAIT_OPERATOR_APPROVAL", approvalId: "merge-approval" });
  });

  it("requests operator-gate reconciliation only when reviewer ownership is stale", () => {
    const p = base([]);
    const headSha = "9d1b229fa0a9102c25b619b1bc5252f1b4851201";
    const card = (stage: "luna" | "terra") => ({
      id: `${stage}-approved`, kind: "request_item_verdicts", status: "answered",
      idempotencyKey: `pr-review:v12:${issue.id}:https://github.com/Pilleo/paperclip-adapters/pull/3:${headSha}:${stage}`,
      result: { items: [{ id: "pull_request", verdict: "approve" }] },
    });
    const decision = evaluateReviewPipelineProgress({
      ...p,
      prNumber: 3,
      prUrl: "https://github.com/Pilleo/paperclip-adapters/pull/3",
      reviewHeadSha: headSha,
      issue: { ...issue, rawIssue: { assigneeAgentId: "agent-luna", executionPolicy: { stages: [] } } },
      lunaReviewerAgentId: "agent-luna",
      terraReviewerAgentId: "agent-terra",
      interactions: [card("luna"), card("terra")],
      existingApprovals: [{ id: "merge-approval", type: "request_board_approval", status: "pending", issueIds: [], payload: { action: "task_merge", issueId: issue.id } }],
    });
    expect(decision).toMatchObject({ action: "RECONCILE_OPERATOR_GATE", approvalId: "merge-approval" });
  });

  it("clears reviewer ownership while preserving the visible operator gate", () => {
    expect(operatorGateReconciliationPatch()).toEqual({
      status: "in_review",
      assigneeAgentId: null,
      executionPolicy: null,
      executionState: null,
    });
  });

  it("treats omitted and null projection fields as an already reconciled gate", () => {
    expect(hasStaleReviewerOwnership({})).toBe(false);
    expect(hasStaleReviewerOwnership({ assigneeAgentId: null, executionPolicy: null, executionState: null })).toBe(false);
    expect(hasStaleReviewerOwnership({ assigneeAgentId: "agent-luna" })).toBe(true);
    expect(hasStaleReviewerOwnership({ executionState: { status: "pending" } })).toBe(true);
  });

  it("keeps an approved native card when the current head lookup is unavailable", () => {
    const p = base([]);
    const sha = "9d1b229fa0a9102c25b619b1bc5252f1b4851201";
    const card = (stage: "luna" | "terra") => ({
      id: `${stage}-approved`, kind: "request_item_verdicts", status: "answered",
      idempotencyKey: `pr-review:v12:${issue.id}:pr-${stage}:${sha}:${stage}`,
      result: { items: [{ id: "pull_request", verdict: "approve" }] },
    });
    expect(evaluateReviewPipelineProgress({
      ...p, prUrl: "pr-526", reviewHeadSha: undefined,
      lunaReviewerAgentId: "agent-luna", terraReviewerAgentId: "agent-terra",
      interactions: [card("luna"), card("terra")],
    }).action).toBe("CREATE_MERGE_APPROVAL");
  });

  it("waits for CI", () => {
    expect(evaluateReviewPipelineProgress({ ...base(), ciStatus: { isGreen: false, status: "pending" } }).action).toBe("AWAIT_CI");
  });

  it("does not accept a comment-shaped verdict", () => {
    const decision = evaluateReviewPipelineProgress({
      ...base(),
      vibeReviewerAgentId: undefined,
      reviewerAgentId: undefined,
      lunaReviewerAgentId: "agent-luna",
      terraReviewerAgentId: "agent-terra",
      comments: [{ id: "comment", body: 'PAPERCLIP_REVIEW_DECISION {"decision":"all_good"}', authorAgentId: "agent-luna" }],
    });
    expect(decision).toMatchObject({ action: "DISPATCH_LUNA_REVIEW", targetAgentId: "agent-luna" });
  });

  it("advances to Terra after Luna approves even when execution policy is still pending", () => {
    const params = {
      ...base(),
      vibeReviewerAgentId: undefined,
      reviewerAgentId: undefined,
      lunaReviewerAgentId: "agent-luna",
      terraReviewerAgentId: "agent-terra",
      interactions: [{
        id: "luna-approve",
        kind: "request_item_verdicts",
        status: "answered",
        idempotencyKey: reviewInteractionIdempotencyKey({ issueId: "issue-141", prUrl: "pr-526", headSha: "unknown", stage: "luna" }),
        result: { items: [{ id: "pull_request", verdict: "approve" }] },
      }],
      executionState: {
        status: "pending",
        currentStageIndex: 0,
        currentParticipant: { type: "agent", agentId: "agent-luna" },
      },
    } satisfies ReviewPipelineParams;
    expect(evaluateReviewPipelineProgress(params)).toMatchObject({ action: "DISPATCH_TERRA_REVIEW", targetAgentId: "agent-terra" });
  });

  it("does not wake Luna when its native approval is already terminal", () => {
    const params = {
      ...base(),
      vibeReviewerAgentId: undefined,
      reviewerAgentId: undefined,
      lunaReviewerAgentId: "agent-luna",
      terraReviewerAgentId: "agent-terra",
      reviewerAgentStatus: "running",
      interactions: [{
        id: "luna-approve",
        kind: "request_item_verdicts",
        status: "answered",
        idempotencyKey: reviewInteractionIdempotencyKey({ issueId: "issue-141", prUrl: "pr-526", headSha: "unknown", stage: "luna" }),
        result: { items: [{ id: "pull_request", verdict: "approve" }] },
      }],
      executionState: {
        status: "pending",
        currentStageIndex: 0,
        currentParticipant: { type: "agent", agentId: "agent-luna" },
      },
    } satisfies ReviewPipelineParams;
    expect(evaluateReviewPipelineProgress(params)).toMatchObject({ action: "DISPATCH_TERRA_REVIEW", targetAgentId: "agent-terra" });
  });

  it("advances from Luna even when the old recovery marker is present", () => {
    const params = {
      ...base(),
      vibeReviewerAgentId: undefined,
      reviewerAgentId: undefined,
      lunaReviewerAgentId: "agent-luna",
      terraReviewerAgentId: "agent-terra",
      interactions: [{
        id: "luna-approve",
        kind: "request_item_verdicts",
        status: "answered",
        idempotencyKey: reviewInteractionIdempotencyKey({ issueId: "issue-141", prUrl: "pr-526", headSha: "unknown", stage: "luna" }),
        result: { items: [{ id: "pull_request", verdict: "approve" }] },
      }],
      executionState: {
        status: "pending",
        currentStageIndex: 0,
        currentParticipant: { type: "agent", agentId: "agent-luna" },
      },
    } satisfies ReviewPipelineParams;
    expect(evaluateReviewPipelineProgress(params)).toMatchObject({ action: "DISPATCH_TERRA_REVIEW", targetAgentId: "agent-terra" });
  });

  it("uses the same recovery protocol for an approved Terra card", () => {
    const params = {
      ...base(),
      vibeReviewerAgentId: undefined,
      reviewerAgentId: undefined,
      lunaReviewerAgentId: "agent-luna",
      terraReviewerAgentId: "agent-terra",
      interactions: [{
        id: "luna-approve",
        kind: "request_item_verdicts",
        status: "answered",
        idempotencyKey: reviewInteractionIdempotencyKey({ issueId: "issue-141", prUrl: "pr-526", headSha: "unknown", stage: "luna" }),
        result: { items: [{ id: "pull_request", verdict: "approve" }] },
      }, {
        id: "terra-approve",
        kind: "request_item_verdicts",
        status: "answered",
        idempotencyKey: reviewInteractionIdempotencyKey({ issueId: "issue-141", prUrl: "pr-526", headSha: "unknown", stage: "terra" }),
        result: { items: [{ id: "pull_request", verdict: "approve" }] },
      }],
      executionState: {
        status: "pending",
        currentStageIndex: 1,
        currentParticipant: { type: "agent", agentId: "agent-terra" },
      },
    } satisfies ReviewPipelineParams;
    expect(evaluateReviewPipelineProgress(params)).toMatchObject({ action: "CREATE_MERGE_APPROVAL" });
  });

  it("uses the Luna then Terra reviewer lane and ignores legacy Vibe approvals", () => {
    const params = {
      ...base(),
      vibeReviewerAgentId: undefined,
      reviewerAgentId: undefined,
      lunaReviewerAgentId: "agent-luna",
      terraReviewerAgentId: "agent-terra",
    };
    expect(evaluateReviewPipelineProgress(params).action).toBe("DISPATCH_LUNA_REVIEW");
    const lunaApproval = {
      id: "luna-approve",
      kind: "request_item_verdicts",
      status: "answered",
      idempotencyKey: reviewInteractionIdempotencyKey({ issueId: "issue-141", prUrl: "pr-526", headSha: "unknown", stage: "luna" }),
      result: { items: [{ id: "pull_request", verdict: "approve" }] },
    };
    expect(evaluateReviewPipelineProgress({ ...params, interactions: [interaction("vibe", "approve"), lunaApproval] }).action).toBe("DISPATCH_TERRA_REVIEW");
  });

  it("does not fall back to the legacy Vibe/Strong lane", () => {
    expect(evaluateReviewPipelineProgress(base())).toMatchObject({
      action: "AWAIT_REVIEW_CONFIGURATION",
      stage: "luna_review",
    });
  });

  it("does not redispatch an active Luna stage when its native card is pending", () => {
    const params = {
      ...base(),
      vibeReviewerAgentId: undefined,
      reviewerAgentId: undefined,
      lunaReviewerAgentId: "agent-luna",
      terraReviewerAgentId: "agent-terra",
      interactions: [nativeCard("luna", "pending")],
      executionState: {
        status: "pending",
        currentStageIndex: 0,
        currentParticipant: { type: "agent", agentId: "agent-luna" },
      },
    };
    expect(evaluateReviewPipelineProgress(params)).toMatchObject({ action: "AWAIT_REVIEW", stage: "luna_review" });
  });

  it("replaces an expired or cancelled card with a fresh idempotency generation", () => {
    for (const status of ["expired", "cancelled"] as const) {
      const params = {
        ...base(),
        vibeReviewerAgentId: undefined,
        reviewerAgentId: undefined,
        lunaReviewerAgentId: "agent-luna",
        terraReviewerAgentId: "agent-terra",
        interactions: [nativeCard("luna", status)],
        executionState: {
          status: "pending",
          currentStageIndex: 0,
          currentParticipant: { type: "agent", agentId: "agent-luna" },
        },
      };
      expect(evaluateReviewPipelineProgress(params)).toMatchObject({ action: "DISPATCH_LUNA_REVIEW", targetAgentId: "agent-luna" });
    }
  });

  it("does not restart an agent review after Paperclip escalates to a human", () => {
    const params = {
      ...base(),
      vibeReviewerAgentId: undefined,
      reviewerAgentId: undefined,
      lunaReviewerAgentId: "agent-luna",
      terraReviewerAgentId: "agent-terra",
      interactions: [nativeCard("luna", "expired")],
      executionState: {
        status: "pending",
        currentStageIndex: 0,
        currentParticipant: { type: "user", agentId: null },
      },
    };
    expect(evaluateReviewPipelineProgress(params)).toMatchObject({ action: "AWAIT_REVIEW", stage: "luna_review" });
  });

  it("fails closed when a required reviewer is not configured", () => {
    expect(evaluateReviewPipelineProgress({ ...base(), vibeReviewerAgentId: undefined, reviewerAgentId: undefined, lunaReviewerAgentId: undefined, terraReviewerAgentId: "agent-terra" })).toMatchObject({
      action: "AWAIT_REVIEW_CONFIGURATION",
      stage: "luna_review",
    });
  });
});
