import { describe, expect, it } from "vitest";
import {
  buildQuestionCorrelation,
  questionCorrelationMarker,
  parseQuestionCorrelation,
  matchesQuestionCorrelation,
} from "../src/server/question-correlation.js";

describe("Jules question correlation", () => {
  const identity = buildQuestionCorrelation({
    parentIssueId: "issue-1",
    companyId: "company-1",
    sessionId: "session-1",
    activityId: "activity-1",
    reviewerAgentId: "reviewer-1",
    question: "Which branch should I use?",
  });

  it("round-trips a stable marker without depending on parentId", () => {
    const marker = questionCorrelationMarker(identity);
    expect(parseQuestionCorrelation(marker)).toEqual(identity);
  });

  it.each([
    ["normal child", { parentId: "issue-1" }],
    ["company fallback", { parentId: null }],
  ])("matches %s by marker and reviewer identity", (_label, issue) => {
    expect(matchesQuestionCorrelation({
      ...issue,
      assigneeAgentId: "reviewer-1",
      status: "todo",
      description: `before\n${questionCorrelationMarker(identity)}\nafter`,
    }, identity)).toBe(true);
  });

  it.each([
    ["wrong reviewer", { assigneeAgentId: "other" }],
    ["wrong activity", { description: "<!-- jules-question-adjudication:v1:other -->" }],
    ["cancelled issue", { status: "cancelled" }],
  ])("rejects %s", (_label, issue) => {
    expect(matchesQuestionCorrelation({
      assigneeAgentId: "reviewer-1",
      status: "todo",
      description: questionCorrelationMarker(identity),
      ...issue,
    }, identity)).toBe(false);
  });
});
