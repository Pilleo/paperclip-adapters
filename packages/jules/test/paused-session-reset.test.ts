import { describe, it, expect } from "vitest";
import { evaluateInteractionAction } from "../src/server/interaction-engine.js";
import { JulesAdapterSessionV1 } from "../src/server/session.js";

const baseSession: JulesAdapterSessionV1 = {
  version: 1,
  paperclipIssueId: "issue-paused-1",
  promptHash: "hash-123",
  repository: "owner/repo",
  source: "sources/github/owner/repo",
  baseBranch: "master",
  phase: "RUNNING",
  attempt: 1,
  failedSessions: [],
  sessionId: "session-paused-999",
  julesSessionId: "session-paused-999",
  julesSessionUrl: "https://jules.google.com/session/session-paused-999",
};

describe("Paused & Archived Session Reset Handling", () => {
  it("evaluates PAUSED state as RESET_PAUSED_SESSION action", () => {
    const action = evaluateInteractionAction(baseSession, "PAUSED", []);
    expect(action.type).toBe("RESET_PAUSED_SESSION");
    if (action.type === "RESET_PAUSED_SESSION") {
      expect(action.sessionId).toBe("session-paused-999");
      expect(action.reason).toBe("operator_paused");
    }
  });
});
