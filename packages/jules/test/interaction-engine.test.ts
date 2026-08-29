import { describe, it, expect } from "vitest";
import {
  evaluateInteractionAction,
  extractFeedbackAnswer,
  recordFeedbackRelayed,
  recordPlanApprovalRelayed,
  determinePaperclipIssueStatus,
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
    it("returns CREATE_FEEDBACK_CARD when no existing interaction exists", () => {
      const action = evaluateInteractionAction(baseSession, "AWAITING_USER_FEEDBACK", [], "What is next?");
      expect(action.type).toBe("CREATE_FEEDBACK_CARD");
      if (action.type === "CREATE_FEEDBACK_CARD") {
        expect(action.question).toBe("What is next?");
        expect(action.attempt).toBe(1);
      }
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

    it("creates a fresh card when previous interaction was already answered and delivered", () => {
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
      expect(action.type).toBe("CREATE_FEEDBACK_CARD");
      if (action.type === "CREATE_FEEDBACK_CARD") {
        expect(action.question).toBe("Second question from Jules?");
      }
    });
  });

  describe("AWAITING_PLAN_APPROVAL transitions", () => {
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

    it("recordPlanApprovalRelayed immutably sets planApprovedAt and transitions to RUNNING", () => {
      const updated = recordPlanApprovalRelayed(baseSession);
      expect(updated.planApprovedAt).toBeDefined();
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
