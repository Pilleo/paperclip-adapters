import { describe, expect, it } from "vitest";
import { questionBridgeAction, questionBridgeIdempotencyKey, QuestionBridgeSnapshot } from "../src/server/question-bridge.js";

const snapshot = (overrides: Partial<QuestionBridgeSnapshot> = {}): QuestionBridgeSnapshot => ({
  parent: "pending", child: "absent", reviewerRun: "absent", delivery: "not_delivered", ...overrides,
});

describe("typed Jules question bridge", () => {
  it.each([
    [snapshot(), "CREATE_CHILD_BRIDGE"],
    [snapshot({ child: "pending", reviewerRun: "running", childIssueId: "child-1" }), "AWAIT_REVIEWER"],
    [snapshot({ child: "pending", reviewerRun: "cancelled_assignee_changed", childIssueId: "child-1" }), "RECREATE_CHILD_FORM"],
    [snapshot({ child: "answered" }), "COPY_ANSWER_TO_PARENT"],
    [snapshot({ child: "escalated" }), "COPY_ESCALATION_TO_PARENT"],
    [snapshot({ parent: "answered", child: "answered", delivery: "parent_recorded" }), "RELAY_ANSWER_TO_JULES"],
    [snapshot({ parent: "answered", child: "escalated", delivery: "parent_recorded" }), "OPEN_HUMAN_ESCALATION"],
    [snapshot({ parent: "closed", child: "answered" }), "COMPLETE_CHILD"],
    [snapshot({ child: "malformed" }), "TERMINAL_FAILURE"],
  ] as const)("selects one safe action for %s", (input, expected) => {
    expect(questionBridgeAction(input)).toBe(expected);
  });

  it("uses a stable generation-scoped identity", () => {
    expect(questionBridgeIdempotencyKey("parent", "session", "activity", 1))
      .toBe("jules:question-review-child:parent:session:activity:1");
  });
});
