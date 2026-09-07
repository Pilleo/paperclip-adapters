import { describe, expect, it } from "vitest";
import { evaluateQuestionAdjudicationChild } from "../src/server/question-adjudication-state.js";

const reviewer = "reviewer-1";

describe("evaluateQuestionAdjudicationChild", () => {
  it.each([
    ["todo", [], "waiting"],
    ["in_progress", [{ authorAgentId: reviewer, body: "I will investigate." }], "waiting"],
    ["done", [{ authorAgentId: reviewer, body: "I will investigate." }], "protocol_error"],
    ["done", [{ authorAgentId: "other", body: '{"kind":"ANSWER","answer":"wrong author"}' }], "protocol_error"],
  ] as const)("classifies status=%s safely as %s", (status, comments, expected) => {
    expect(evaluateQuestionAdjudicationChild({ status, reviewerAgentId: reviewer, comments }).state).toBe(expected);
  });

  it.each([
    ['{"kind":"ANSWER","answer":"Run the declared tests."}', "answer"],
    ['{"kind":"ESCALATE","reason":"The parent does not specify the target branch."}', "escalate"],
  ] as const)("accepts only the typed decision %s", (body, expected) => {
    expect(evaluateQuestionAdjudicationChild({
      status: "done", reviewerAgentId: reviewer, comments: [{ authorAgentId: reviewer, body }],
    }).state).toBe(expected);
  });
});
