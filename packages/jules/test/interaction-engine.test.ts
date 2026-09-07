import { describe, it, expect } from "vitest";
import {
  evaluateInteractionAction,
  extractPlanReviewVerdict,
  extractFeedbackAnswer,
  recordFeedbackRelayed,
  recordPlanApprovalRelayed,
  isPlanApprovalRequired,
  determinePaperclipIssueStatus,
  fingerprintPlanSteps,
} from "../src/server/interaction-engine.js";
import { JulesAdapterSessionV1 } from "../src/server/session.js";
import { PaperclipInteraction } from "../src/server/paperclip-client.js";

const baseSession: JulesAdapterSessionV1 = {
  version: 1,
  paperclipIssueId: "issue-123",
  promptHash: "hash",
  repository: "owner/repo",
  source: "github",
  baseBranch: "main",
  phase: "RUNNING",
  attempt: 1,
  failedSessions: [],
  sessionId: "jules-session-1",
  julesSessionId: "jules-session-1",
};

describe("interaction-engine pure reducer", () => {
  it.each([
    [{ outcome: "resolved", complete: true, items: [{ id: "plan", verdict: "approve" }] }, { decision: "approve" }],
    [{ outcome: "resolved", complete: true, items: [{ id: "plan", verdict: "reject", reason: "Clarify rollback." }] }, { decision: "reject", reason: "Clarify rollback." }],
  ] as const)("extracts typed plan verdicts without reading comments", (result, expected) => {
    expect(extractPlanReviewVerdict({ id: "plan-card", kind: "request_item_verdicts", status: "answered", result })).toEqual(expected);
  });

  it("does not treat an incomplete typed result as a plan decision", () => {
    expect(extractPlanReviewVerdict({
      id: "plan-card", kind: "request_item_verdicts", status: "answered",
      result: { outcome: "resolved", complete: false, items: [{ id: "plan", verdict: "approve" }] },
    })).toBeNull();
  });

  it("extracts feedback answer from result payload correctly", () => {
    expect(extractFeedbackAnswer(null)).toBeNull();
    expect(extractFeedbackAnswer({})).toBeNull();
    expect(extractFeedbackAnswer({ answers: [] })).toBeNull();
    expect(extractFeedbackAnswer({ answers: [{ otherText: "My answer" }] })).toBe("My answer");
    expect(extractFeedbackAnswer({ answers: [{ optionId: "opt-1" }] })).toBe("opt-1");
    expect(extractFeedbackAnswer({ answers: [{ optionId: "response" }] })).toBeNull();
    expect(extractFeedbackAnswer({ answers: [{ optionId: "response", otherText: "Real text" }] })).toBe("Real text");
  });

  describe("AWAITING_USER_FEEDBACK transitions", () => {
    it("delegates a provider question to the strong-reviewer lane", () => {
      const action = evaluateInteractionAction(baseSession, "AWAITING_USER_FEEDBACK", [], "What is next?");
      expect(action.type).toBe("CREATE_AGENT_ADJUDICATION");
      if (action.type === "CREATE_AGENT_ADJUDICATION") {
        expect(action.question).toBe("What is next?");
      }
    });

    it("does not reopen a question whose Jules activity was already answered", () => {
      const action = evaluateInteractionAction(
        { ...baseSession, deliveredFeedbackActivityId: "activity-1" },
        "AWAITING_USER_FEEDBACK",
        [],
        "Anything else?",
        "activity-1",
      );
      expect(action.type).toBe("CONTINUE_POLLING");
    });

    it("does not let a stale agent-adjudication form hide a newer Jules question", () => {
      const staleReviewerRecord: PaperclipInteraction = {
        id: "old-reviewer-form",
        kind: "ask_user_questions",
        status: "pending",
        idempotencyKey: "jules:agent-adjudication:MAZ-834:session-1:old-question",
      };
      const action = evaluateInteractionAction(
        baseSession,
        "AWAITING_USER_FEEDBACK",
        [staleReviewerRecord],
        "Am I clear to finalize these changes?",
        "new-question",
      );
      expect(action).toEqual({
        type: "CREATE_AGENT_ADJUDICATION",
        question: "Am I clear to finalize these changes?",
      });
    });

    it("returns WAIT_FOR_HUMAN when an unanswered pending interaction exists", () => {
      const pending: PaperclipInteraction = {
        id: "inter-1",
        kind: "ask_user_questions",
        status: "pending",
      };
      const action = evaluateInteractionAction(baseSession, "AWAITING_USER_FEEDBACK", [pending]);
      expect(action.type).toBe("WAIT_FOR_HUMAN");
      if (action.type === "WAIT_FOR_HUMAN") {
        expect(action.interactionId).toBe("inter-1");
      }
    });

    it("returns RELAY_FEEDBACK when an answered interaction has not been relayed", () => {
      const answered: PaperclipInteraction = {
        id: "inter-1",
        kind: "ask_user_questions",
        status: "answered",
        result: { answers: [{ otherText: "Proceed with test cleanup" }] },
      };
      const sessionWithPending = {
        ...baseSession,
        pendingInteraction: {
          type: "user_feedback" as const,
          julesActivityId: "act-1",
          paperclipInteractionId: "inter-1",
          question: "Question?",
          createdAt: new Date().toISOString(),
        },
      };
      const action = evaluateInteractionAction(sessionWithPending, "AWAITING_USER_FEEDBACK", [answered]);
      expect(action.type).toBe("RELAY_FEEDBACK");
      if (action.type === "RELAY_FEEDBACK") {
        expect(action.answer).toBe("Proceed with test cleanup");
        expect(action.interactionId).toBe("inter-1");
      }
    });

    it("delegates a new question when previous feedback was already delivered", () => {
      const answeredOld: PaperclipInteraction = {
        id: "inter-old-1",
        kind: "ask_user_questions",
        status: "answered",
        result: { answers: [{ otherText: "First answer" }] },
      };
      const sessionWithDelivered = {
        ...baseSession,
        deliveredFeedbackInteractionId: "inter-old-1",
      };
      const action = evaluateInteractionAction(sessionWithDelivered, "AWAITING_USER_FEEDBACK", [answeredOld], "Second question from Jules?");
      expect(action.type).toBe("CREATE_AGENT_ADJUDICATION");
      if (action.type === "CREATE_AGENT_ADJUDICATION") {
        expect(action.question).toBe("Second question from Jules?");
      }
    });
  });

  describe("AWAITING_PLAN_APPROVAL transitions", () => {
    it("fingerprints typed plan steps deterministically and ignores ordering", () => {
      expect(fingerprintPlanSteps([
        { index: 2, title: " Run tests ", description: "Verify" },
        { index: 1, title: "Implement", description: "Code" },
      ])).toBe(fingerprintPlanSteps([
        { index: 1, title: "Implement", description: "Code" },
        { index: 2, title: "Run tests", description: "Verify" },
      ]));
      expect(fingerprintPlanSteps([{ index: 1, title: "Other" }])).not.toBe(
        fingerprintPlanSteps([{ index: 1, title: "Implement" }]),
      );
    });

    it.each([
      { activityId: "plan-1", approvedActivityId: "plan-1", approvedAt: "now", expected: false },
      { activityId: "plan-2", approvedActivityId: "plan-1", approvedAt: "now", expected: true },
      { activityId: "plan-1", approvedActivityId: undefined, approvedAt: undefined, expected: true },
      { activityId: "plan-1", approvedActivityId: undefined, approvedAt: "legacy", expected: false },
      { activityId: undefined, approvedActivityId: "plan-1", expected: false },
    ])("requires approval only for a new provider plan activity", ({ activityId, approvedActivityId, approvedAt, expected }) => {
      expect(isPlanApprovalRequired({
        requirePlanApproval: true,
        planActivityId: activityId,
        planApprovedAt: approvedAt,
        planApprovedActivityId: approvedActivityId,
      })).toBe(expected);
    });

    it("does not reopen an exact plan fingerprint after rejection", () => {
      expect(isPlanApprovalRequired({
        requirePlanApproval: true,
        planActivityId: "new-activity",
        planFingerprint: "same-plan",
        supersededPlanFingerprint: "same-plan",
      })).toBe(false);
      expect(isPlanApprovalRequired({
        requirePlanApproval: true,
        planActivityId: "new-activity",
        planFingerprint: "changed-plan",
        supersededPlanFingerprint: "same-plan",
      })).toBe(true);
    });

    it("does not infer a plan gate from provider prose while state is active", () => {
      const action = evaluateInteractionAction(baseSession, "IN_PROGRESS", [], "Jules Implementation Plan\nStep 1");
      expect(action.type).toBe("CONTINUE_POLLING");
    });

    it("returns CREATE_PLAN_CARD when no plan card exists", () => {
      const action = evaluateInteractionAction(baseSession, "AWAITING_PLAN_APPROVAL", [], "Step 1: Code");
      expect(action.type).toBe("CREATE_PLAN_CARD");
      if (action.type === "CREATE_PLAN_CARD") {
        expect(action.planMarkdown).toBe("Step 1: Code");
      }
    });

    it("returns RELAY_PLAN_APPROVAL when plan card was accepted", () => {
      const accepted: PaperclipInteraction = {
        id: "plan-inter-1",
        kind: "request_confirmation",
        status: "accepted",
        result: { planRevisionId: "rev-42" },
      };
      const sessionWithPending = {
        ...baseSession,
        pendingInteraction: {
          type: "plan_approval" as const,
          julesActivityId: "act-1",
          paperclipInteractionId: "plan-inter-1",
          planRevisionId: "rev-42",
          createdAt: new Date().toISOString(),
        },
      };
      const action = evaluateInteractionAction(sessionWithPending, "AWAITING_PLAN_APPROVAL", [accepted]);
      expect(action.type).toBe("RELAY_PLAN_APPROVAL");
      if (action.type === "RELAY_PLAN_APPROVAL") {
        expect(action.planRevisionId).toBe("rev-42");
        expect(action.interactionId).toBe("plan-inter-1");
      }
    });

    it("relays an accepted plan card even when pendingInteraction was lost", () => {
      const accepted: PaperclipInteraction = {
        id: "plan-inter-lost",
        kind: "request_confirmation",
        status: "accepted",
        result: { planRevisionId: "rev-lost" },
      };
      const action = evaluateInteractionAction(baseSession, "AWAITING_PLAN_APPROVAL", [accepted]);
      expect(action.type).toBe("RELAY_PLAN_APPROVAL");
      if (action.type === "RELAY_PLAN_APPROVAL") {
        expect(action.planRevisionId).toBe("rev-lost");
        expect(action.interactionId).toBe("plan-inter-lost");
      }
    });

    it("returns WAIT_FOR_HUMAN when plan was already approved", () => {
      const accepted: PaperclipInteraction = {
        id: "plan-inter-1",
        kind: "request_confirmation",
        status: "accepted",
        result: { planRevisionId: "rev-42" },
      };
      const sessionApproved = {
        ...baseSession,
        planApprovedAt: "2026-08-27T18:00:00.000Z",
      };
      const action = evaluateInteractionAction(sessionApproved, "AWAITING_PLAN_APPROVAL", [accepted]);
      expect(action.type).toBe("WAIT_FOR_HUMAN");
    });
  });

  describe("Pure state updates", () => {
    it("recordFeedbackRelayed immutably sets deliveredFeedbackInteractionId and transitions to RUNNING", () => {
      const updated = recordFeedbackRelayed(baseSession, "inter-99");
      expect(updated.deliveredFeedbackInteractionId).toBe("inter-99");
      expect(updated.phase).toBe("RUNNING");
      expect(updated.pendingInteraction).toBeUndefined();
      expect(baseSession.deliveredFeedbackInteractionId).toBeUndefined();
    });

    it("recordPlanApprovalRelayed binds approval to the exact provider plan activity", () => {
      const updated = recordPlanApprovalRelayed(baseSession, "plan-activity-1");
      expect(updated.planApprovedAt).toBeDefined();
      expect(updated.planApprovedActivityId).toBe("plan-activity-1");
      expect(updated.phase).toBe("RUNNING");
      expect(updated.pendingInteraction).toBeUndefined();
    });
  });

  describe("Paperclip issue status mapping invariants", () => {
    it("never emits status: blocked or unblock descriptors during user feedback", () => {
      const policy = determinePaperclipIssueStatus("WAITING_FOR_FEEDBACK");
      expect(policy.status).toBe("in_progress");
      expect(policy.unblockDescriptor).toBeNull();
    });

    it("never emits status: blocked or unblock descriptors during plan approval", () => {
      const policy = determinePaperclipIssueStatus("WAITING_FOR_PLAN_APPROVAL");
      expect(policy.status).toBe("in_progress");
      expect(policy.unblockDescriptor).toBeNull();
    });

    it("maps COMPLETED to in_review", () => {
      const policy = determinePaperclipIssueStatus("COMPLETED");
      expect(policy.status).toBe("in_review");
      expect(policy.unblockDescriptor).toBeNull();
    });
  });
});
