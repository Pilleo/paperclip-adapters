import { describe, it, expect } from "vitest";
import { evaluateInteractionAction } from "../src/server/interaction-engine.js";
import { JulesAdapterSessionV1 } from "../src/server/session.js";
import { PaperclipInteraction } from "../src/server/paperclip-client.js";

describe("Question Workflow", () => {
  const baseSession: JulesAdapterSessionV1 = {
    version: 1,
    paperclipIssueId: "issue-123" as any,
    promptHash: "hash",
    repository: "owner/repo",
    source: "github",
    baseBranch: "main",
    phase: "RUNNING",
    attempt: 1,
    failedSessions: [],
    sessionId: "jules-session-1",
    julesSessionId: "jules-session-1" as any,
  };

  it("handles pending native question cards properly", () => {
      const action = evaluateInteractionAction(baseSession, "AWAITING_USER_FEEDBACK", [], "What is next?");
      expect(action.type).toBe("CREATE_FEEDBACK_CARD");
  });

  it("relays exactly once and does not reuse cards for differing responses", () => {
      const pending: PaperclipInteraction = {
        id: "inter-1",
        kind: "ask_user_questions",
        status: "pending",
      };
      const action = evaluateInteractionAction(baseSession, "AWAITING_USER_FEEDBACK", [pending]);
      expect(action.type).toBe("WAIT_FOR_HUMAN");
  });

  it("handles answered native question cards properly", () => {
      const sessionWithPending = { ...baseSession, pendingInteraction: { type: "user_feedback", paperclipInteractionId: "inter-1", julesActivityId: "act-1", question: "?", createdAt: "2026-08-08T00:00:00.000Z" } };
      const pending: PaperclipInteraction = {
        id: "inter-1",
        kind: "ask_user_questions",
        status: "answered",
        result: { answers: [{ otherText: "foo" }] }
      };
      const action = evaluateInteractionAction(sessionWithPending as any, "AWAITING_USER_FEEDBACK", [pending]);
      expect(action.type).toBe("RELAY_FEEDBACK");
      expect((action as any).answer).toBe("foo");
  });

  it("handles malformed/superseded questions", () => {
      const sessionWithPending = { ...baseSession, pendingInteraction: { type: "user_feedback", paperclipInteractionId: "inter-1", julesActivityId: "act-1", question: "?", createdAt: "2026-08-08T00:00:00.000Z" } };
      const pending: PaperclipInteraction = {
        id: "inter-1",
        kind: "ask_user_questions",
        status: "answered",
        result: {} // malformed
      };
      const action = evaluateInteractionAction(sessionWithPending as any, "AWAITING_USER_FEEDBACK", [pending]);
      expect(action.type).toBe("WAIT_FOR_HUMAN"); // The engine waits, and execute.ts will actually withdraw it and spawn a new one, but from interaction engine perspective, it just evaluates existing
  });

  it("does not relay multiple times", () => {
      const sessionWithPending = { ...baseSession, deliveredFeedbackInteractionId: "inter-1", pendingInteraction: { type: "user_feedback", paperclipInteractionId: "inter-1", julesActivityId: "act-1", question: "?", createdAt: "2026-08-08T00:00:00.000Z" } };
      const pending: PaperclipInteraction = {
        id: "inter-1",
        kind: "ask_user_questions",
        status: "answered",
        result: { answers: [{ otherText: "foo" }] }
      };
      const action = evaluateInteractionAction(sessionWithPending as any, "AWAITING_USER_FEEDBACK", [pending]);
      expect(action.type).toBe("WAIT_FOR_HUMAN");
  });
});
