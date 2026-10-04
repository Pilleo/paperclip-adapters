import { describe, expect, it } from "vitest";
import { hasPendingJulesQuestion } from "../src/core/jules-question-state.js";

describe("blocked native question ownership", () => {
  it("preserves the Jules wait while its direct-answer or human-escalation card is pending", () => {
    for (const kind of ["agent-adjudication", "human-escalation", "user-feedback"]) {
      expect(hasPendingJulesQuestion("parent", [{ kind: "ask_user_questions", status: "pending", idempotencyKey: `jules:${kind}:parent:original:activity:presentation:v2` }])).toBe(true);
    }
  });
  it("does not claim unrelated or already answered cards", () => {
    expect(hasPendingJulesQuestion("parent", [{ kind: "ask_user_questions", status: "pending", idempotencyKey: "jules:human-escalation:different:session:activity" }])).toBe(false);
    expect(hasPendingJulesQuestion("parent", [{ kind: "ask_user_questions", status: "answered", idempotencyKey: "jules:human-escalation:parent:session:activity" }])).toBe(false);
  });
});
