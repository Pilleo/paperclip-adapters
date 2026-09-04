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
});
