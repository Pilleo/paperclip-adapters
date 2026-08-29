import { describe, it, expect } from "vitest";
import { extractResolvedInteraction, formatClarifyingQuestionCard } from "../src/server/interaction-relay.js";
import { asPaperclipId, asJulesSessionId, asJulesActivityId } from "../src/server/brands.js";
import { JulesAdapterSessionV1 } from "../src/server/session.js";

describe("interaction-relay", () => {
  const baseSession: JulesAdapterSessionV1 = {
    version: 1,
    paperclipIssueId: asPaperclipId("task-123"),
    promptHash: "hash123",
    repository: "Pilleo/mazewall",
    source: "sources/github/Pilleo/mazewall",
    baseBranch: "master",
    phase: "WAITING_FOR_PLAN_APPROVAL",
    sessionId: "sess-1",
    julesSessionId: asJulesSessionId("sess-1"),
    attempt: 1,
    failedSessions: [],
    createdAt: new Date().toISOString(),
    pendingInteraction: {
      type: "plan_approval",
      julesActivityId: asJulesActivityId("act-1"),
      paperclipInteractionId: "inter-1",
      question: "Approve plan?",
      planDocumentId: "doc-1",
      planRevisionId: "rev-1",
      planRevisionNumber: 1,
      createdAt: new Date().toISOString()
    }
  };

  it("extracts accepted plan confirmation interaction", () => {
    const rawContext = {
      planReviewInteraction: {
        id: "inter-1",
        kind: "request_confirmation",
        status: "accepted",
        result: { outcome: "accepted" }
      }
    };

    const resolved = extractResolvedInteraction(rawContext, baseSession);
    expect(resolved.type).toBe("plan_approval");
    expect(resolved.isAccepted).toBe(true);
    expect(resolved.isRejected).toBe(false);
    expect(resolved.interactionId).toBe("inter-1");
  });

  it("extracts answered user feedback interaction", () => {
    const feedbackSession: JulesAdapterSessionV1 = {
      ...baseSession,
      phase: "WAITING_FOR_FEEDBACK",
      pendingInteraction: {
        type: "user_feedback",
        julesActivityId: asJulesActivityId("act-2"),
        paperclipInteractionId: "inter-2",
        question: "What to do?",
        createdAt: new Date().toISOString()
      }
    };

    const rawContext = {
      interactionId: "inter-2",
      interactionKind: "ask_user_questions",
      interactionResponse: "Refactor first"
    };

    const resolved = extractResolvedInteraction(rawContext, feedbackSession);
    expect(resolved.type).toBe("user_feedback");
    expect(resolved.isAnswered).toBe(true);
    expect(resolved.answer).toBe("Refactor first");
  });

  it("formats clarifying question cards cleanly", () => {
    const card = formatClarifyingQuestionCard("Should I refactor execute.ts first?");
    expect(card.title).toBe("Clarification Needed from Jules");
    expect(card.questionText).toBe("Should I refactor execute.ts first?");
  });
});
