import { describe, it, expect } from "vitest";
import {
  evaluateReviewPipelineProgress,
  ReviewPipelineParams,
  ReviewPipelineDecision,
} from "../src/core/review-pipeline.js";
import { ParsedIssueMetadata } from "../src/core/types.js";

describe("Multi-Tier Review Pipeline & Anti-Hack Gate", () => {
  const baseIssue: ParsedIssueMetadata = {
    id: "issue-141",
    identifier: "MAZ-141",
    issueNumber: 141,
    title: "Cap SandboxDispatcher poolCache growth",
    status: "in_review",
    priority: "high",
    component: "enforcer",
    dependencies: [],
    targetFiles: ["enforcer/src/main/kotlin/io/mazewall/enforcer/api/SandboxDispatcher.kt"],
    targetSymbols: ["SandboxDispatcher.poolCache"],
    rawIssue: {},
  };

  it("halts at Stage 1 (CI_GATE) if CI is pending or failed", () => {
    const params: ReviewPipelineParams = {
      issue: baseIssue,
      prNumber: 526,
      ciStatus: { isGreen: false, status: "pending" },
      comments: [],
      existingApprovals: [],
      vibeAgentId: "agent-vibe",
      reviewerAgentId: "agent-reviewer",
      workerAgentId: "agent-jules",
    };

    const decision = evaluateReviewPipelineProgress(params);
    expect(decision.action).toBe("AWAIT_CI");
    expect(decision.stage).toBe("ci_gate");
  });

  it("advances to Stage 2 (VIBE_REVIEW) when CI is green and no reviews exist", () => {
    const params: ReviewPipelineParams = {
      issue: baseIssue,
      prNumber: 526,
      ciStatus: { isGreen: true, status: "success" },
      comments: [],
      existingApprovals: [],
      vibeAgentId: "agent-vibe",
      reviewerAgentId: "agent-reviewer",
      workerAgentId: "agent-jules",
    };

    const decision = evaluateReviewPipelineProgress(params);
    expect(decision.action).toBe("DISPATCH_VIBE_REVIEW");
    expect(decision.stage).toBe("vibe_review");
    expect(decision.targetAgentId).toBe("agent-vibe");
  });

  it("halts and reassigns to worker if Vibe fast review requests changes (skips expensive strong review)", () => {
    const params: ReviewPipelineParams = {
      issue: baseIssue,
      prNumber: 526,
      ciStatus: { isGreen: true, status: "success" },
      comments: [
        {
          id: "c1",
          authorAgentId: "agent-vibe",
          body: "## 🛑 Automated Code Review Verdict: **REQUEST_CHANGES**\n> Pre-flight check failed: Dummy test assertions detected.",
          createdAt: "2026-08-30T10:00:00Z",
        },
      ],
      existingApprovals: [],
      vibeAgentId: "agent-vibe",
      reviewerAgentId: "agent-reviewer",
      workerAgentId: "agent-jules",
    };

    const decision = evaluateReviewPipelineProgress(params);
    expect(decision.action).toBe("REASSIGN_TO_WORKER");
    expect(decision.stage).toBe("vibe_review");
    expect(decision.targetAssigneeId).toBe("agent-jules");
  });

  it("advances to Stage 3 (STRONG_REVIEW) when Vibe review approves", () => {
    const params: ReviewPipelineParams = {
      issue: baseIssue,
      prNumber: 526,
      ciStatus: { isGreen: true, status: "success" },
      comments: [
        {
          id: "c1",
          authorAgentId: "agent-vibe",
          body: "## ✅ Automated Code Review Verdict: **APPROVE**\n> Fast AST and structural sanity checks passed.",
          createdAt: "2026-08-30T10:00:00Z",
        },
      ],
      existingApprovals: [],
      vibeAgentId: "agent-vibe",
      reviewerAgentId: "agent-reviewer",
      workerAgentId: "agent-jules",
    };

    const decision = evaluateReviewPipelineProgress(params);
    expect(decision.action).toBe("DISPATCH_STRONG_REVIEW");
    expect(decision.stage).toBe("strong_review");
    expect(decision.targetAgentId).toBe("agent-reviewer");
  });

  it("halts and reassigns to worker if Strong Reviewer requests changes", () => {
    const params: ReviewPipelineParams = {
      issue: baseIssue,
      prNumber: 526,
      ciStatus: { isGreen: true, status: "success" },
      comments: [
        {
          id: "c1",
          authorAgentId: "agent-vibe",
          body: "## ✅ Automated Code Review Verdict: **APPROVE**\n> Fast AST and structural sanity checks passed.",
          createdAt: "2026-08-30T10:00:00Z",
        },
        {
          id: "c2",
          authorAgentId: "agent-reviewer",
          body: "## 🛑 Automated Code Review Verdict: **REQUEST_CHANGES**\n> Landlock policy identity is not preserved in CacheKey.",
          createdAt: "2026-08-30T10:05:00Z",
        },
      ],
      existingApprovals: [],
      vibeAgentId: "agent-vibe",
      reviewerAgentId: "agent-reviewer",
      workerAgentId: "agent-jules",
    };

    const decision = evaluateReviewPipelineProgress(params);
    expect(decision.action).toBe("REASSIGN_TO_WORKER");
    expect(decision.stage).toBe("strong_review");
    expect(decision.targetAssigneeId).toBe("agent-jules");
  });

  it("advances to Stage 4 (OPERATOR_APPROVAL) when both Vibe and Strong Reviewer approve", () => {
    const params: ReviewPipelineParams = {
      issue: baseIssue,
      prNumber: 526,
      ciStatus: { isGreen: true, status: "success" },
      comments: [
        {
          id: "c1",
          authorAgentId: "agent-vibe",
          body: "## ✅ Automated Code Review Verdict: **APPROVE**\n> Fast AST and structural sanity checks passed.",
          createdAt: "2026-08-30T10:00:00Z",
        },
        {
          id: "c2",
          authorAgentId: "agent-reviewer",
          body: "## ✅ Automated Code Review Verdict: **APPROVE**\n> Verified Landlock isolation, FFM correctness, and test discipline.",
          createdAt: "2026-08-30T10:05:00Z",
        },
      ],
      existingApprovals: [],
      vibeAgentId: "agent-vibe",
      reviewerAgentId: "agent-reviewer",
      workerAgentId: "agent-jules",
    };

    const decision = evaluateReviewPipelineProgress(params);
    expect(decision.action).toBe("CREATE_MERGE_APPROVAL");
    expect(decision.stage).toBe("operator_approval");
  });

  it("executes merge when operator approves the merge approval card in Paperclip", () => {
    const params: ReviewPipelineParams = {
      issue: baseIssue,
      prNumber: 526,
      ciStatus: { isGreen: true, status: "success" },
      comments: [
        {
          id: "c1",
          authorAgentId: "agent-vibe",
          body: "## ✅ Automated Code Review Verdict: **APPROVE**\n> Fast AST checks passed.",
          createdAt: "2026-08-30T10:00:00Z",
        },
        {
          id: "c2",
          authorAgentId: "agent-reviewer",
          body: "## ✅ Automated Code Review Verdict: **APPROVE**\n> Verified all invariants.",
          createdAt: "2026-08-30T10:05:00Z",
        },
      ],
      existingApprovals: [
        {
          id: "app-1",
          type: "task_merge_approval",
          status: "approved",
          issueIds: [baseIssue.id],
        },
      ],
      vibeAgentId: "agent-vibe",
      reviewerAgentId: "agent-reviewer",
      workerAgentId: "agent-jules",
    };

    const decision = evaluateReviewPipelineProgress(params);
    expect(decision.action).toBe("EXECUTE_MERGE");
    expect(decision.stage).toBe("completed");
    expect(decision.prNumber).toBe(526);
  });
});
