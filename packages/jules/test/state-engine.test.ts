import { describe, it, expect } from "vitest";
import {
  evaluateJulesLifecycleState,
  JulesLifecycleSignals,
} from "../src/server/state-engine.js";
import { JulesAdapterSessionV1 } from "../src/server/session.js";
import { buildValidatedIssuePatch } from "../src/server/disposition.js";

describe("Jules Pure State Engine & Disposition Invariants", () => {
  const baseSession: JulesAdapterSessionV1 = {
    version: 1,
    paperclipIssueId: "issue-141",
    promptHash: "hash-141",
    repository: "Pilleo/mazewall",
    source: "sources/github/Pilleo/mazewall",
    baseBranch: "master",
    phase: "RUNNING",
    sessionId: "8734577004110332897",
    julesSessionId: "8734577004110332897",
    attempt: 1,
    failedSessions: [],
    createdAt: "2026-08-30T00:00:00Z",
  };

  describe("Disposition Validator", () => {
    it("rejects in_review status mutation without valid disposition", () => {
      const result = buildValidatedIssuePatch("in_review");
      expect(result.isValid).toBe(false);
      expect(result.error).toContain("Moving to in_review requires an InReviewDisposition");
    });

    it("accepts in_review mutation with linked interaction card disposition", () => {
      const result = buildValidatedIssuePatch("in_review", {
        targetStatus: "in_review",
        kind: "interaction_card",
        interactionId: "interaction-abc",
      });
      expect(result.isValid).toBe(true);
      expect(result.payloadPatch).toMatchObject({
        status: "in_review",
        reviewInteractionId: "interaction-abc",
      });
    });

    it("accepts in_review mutation with assigned reviewer disposition", () => {
      const result = buildValidatedIssuePatch("in_review", {
        targetStatus: "in_review",
        kind: "assigned_reviewer",
        reviewerAgentId: "agent-reviewer-1",
      });
      expect(result.isValid).toBe(true);
      expect(result.payloadPatch).toMatchObject({
        status: "in_review",
        assigneeAgentId: "agent-reviewer-1",
      });
    });
  });

  describe("Pure Lifecycle Evaluator", () => {
    it("keeps session alive in in_review phase while PR is open and CI is green", () => {
      const signals: JulesLifecycleSignals = {
        julesState: "COMPLETED",
        prUrl: "https://github.com/Pilleo/mazewall/pull/526",
        prDetails: { isMerged: false, mergeableStatus: "clean" },
        ciStatus: "success",
        unreadReviewComments: [],
        existingInteractions: [],
        nowMs: Date.now(),
      };

      const plan = evaluateJulesLifecycleState(baseSession, signals);
      expect(plan.phase).toBe("IN_REVIEW");
      expect(plan.shouldDeleteSession).toBe(false);
      expect(plan.issueTransition).not.toBeNull();
      expect(plan.issueTransition?.targetStatus).toBe("in_review");
    });

    it("triggers RELAY_REVIEW_FEEDBACK when unread review comments are detected", () => {
      const signals: JulesLifecycleSignals = {
        julesState: "COMPLETED",
        prUrl: "https://github.com/Pilleo/mazewall/pull/526",
        prDetails: { isMerged: false, mergeableStatus: "clean" },
        ciStatus: "success",
        unreadReviewComments: [
          {
            id: "review-comment-1",
            body: "🚨 Severity: BLOCKING\n🎯 Recommendation: REQUEST_CHANGES",
          },
        ],
        existingInteractions: [],
        nowMs: Date.now(),
      };

      const plan = evaluateJulesLifecycleState(baseSession, signals);
      expect(plan.phase).toBe("APPLYING_REVIEW_CHANGES");
      expect(plan.actions).toContainEqual(
        expect.objectContaining({
          type: "RELAY_REVIEW_FEEDBACK",
          commentId: "review-comment-1",
        })
      );
      expect(plan.shouldDeleteSession).toBe(false);
    });

    it("marks completed and deletes session ONLY when PR is merged", () => {
      const signals: JulesLifecycleSignals = {
        julesState: "COMPLETED",
        prUrl: "https://github.com/Pilleo/mazewall/pull/526",
        prDetails: { isMerged: true, mergeableStatus: "clean" },
        ciStatus: "success",
        unreadReviewComments: [],
        existingInteractions: [],
        nowMs: Date.now(),
      };

      const plan = evaluateJulesLifecycleState(baseSession, signals);
      expect(plan.phase).toBe("COMPLETED_AND_MERGED");
      expect(plan.shouldDeleteSession).toBe(true);
      expect(plan.issueTransition?.targetStatus).toBe("done");
    });

    it.each([
      {
        desc: "merged PR wins over scope drift",
        signals: {
          julesState: "COMPLETED",
          prUrl: "https://github.com/Pilleo/mazewall/pull/1",
          prDetails: { isMerged: true, mergeableStatus: "mergeable" as const },
          ciStatus: "success" as const,
          scopeConformant: false,
        },
        phase: "COMPLETED_AND_MERGED",
        shouldDeleteSession: true,
      },
      {
        desc: "conflicts stay on the same session",
        signals: {
          julesState: "COMPLETED",
          prUrl: "https://github.com/Pilleo/mazewall/pull/1",
          prDetails: { isMerged: false, mergeableStatus: "conflicting" as const },
          ciStatus: "pending" as const,
          scopeConformant: true,
        },
        phase: "PR_CREATED_AWAITING_CI",
        shouldDeleteSession: false,
      },
      {
        desc: "scope drift before in_review",
        signals: {
          julesState: "COMPLETED",
          prUrl: "https://github.com/Pilleo/mazewall/pull/1",
          prDetails: { isMerged: false, mergeableStatus: "mergeable" as const },
          ciStatus: "success" as const,
          scopeConformant: false,
          scopeSummary: "Unplanned file README.md",
        },
        phase: "CODING",
        shouldDeleteSession: false,
      },
    ])("lifecycle table: $desc", ({ signals, phase, shouldDeleteSession }) => {
      const plan = evaluateJulesLifecycleState(baseSession, signals);
      expect(plan.phase).toBe(phase);
      expect(plan.shouldDeleteSession).toBe(shouldDeleteSession);
    });

    it("flags scope drift before review and keeps the Jules session", () => {
      const plan = evaluateJulesLifecycleState(baseSession, {
        julesState: "COMPLETED",
        prUrl: "https://github.com/Pilleo/mazewall/pull/1",
        prDetails: { isMerged: false, mergeableStatus: "mergeable" },
        ciStatus: "success",
        scopeConformant: false,
        scopeSummary: "Unplanned file README.md",
        unreadReviewComments: [],
        nowMs: Date.now(),
      });
      expect(plan.phase).toBe("CODING");
      expect(plan.shouldDeleteSession).toBe(false);
      expect(plan.shouldExitRun).toBe(true);
      expect(plan.actions).toEqual([
        expect.objectContaining({ type: "FLAG_SCOPE_DRIFT", summary: "Unplanned file README.md" }),
      ]);
    });

    it("triggers watchdog nudge when session is idle for >15m in IN_PROGRESS", () => {
      const now = Date.now();
      const signals: JulesLifecycleSignals = {
        julesState: "IN_PROGRESS",
        lastActivityTime: new Date(now - 16 * 60 * 1000).toISOString(),
        unreadReviewComments: [],
        existingInteractions: [],
        nowMs: now,
      };

      const plan = evaluateJulesLifecycleState(baseSession, signals);
      expect(plan.actions).toContainEqual(
        expect.objectContaining({
          type: "NUDGE_WATCHDOG",
        })
      );
    });
  });
});
