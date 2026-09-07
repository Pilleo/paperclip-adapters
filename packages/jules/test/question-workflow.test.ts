import { describe, expect, it } from "vitest";
import { classifyNativeQuestionReview, isExpiredQuestionBridge, readQuestionReviewFormDecision, reduceQuestionWorkflow } from "../src/server/question-workflow.js";

const base = (overrides: Record<string, unknown> = {}) => ({
  parentIssueId: "parent-1",
  sessionId: "session-1",
  activityId: "activity-1",
  parentCard: { state: "pending" as const, id: "card-1" },
  reviewerChild: { state: "waiting" as const, id: "child-1" },
  ...overrides,
});

describe("Jules question workflow", () => {
  it.each([
    [{ answers: [
      { questionId: "resolution", optionIds: ["answer"] },
      { questionId: "response", otherText: "Run the declared tests." },
    ] }, { kind: "ANSWER", answer: "Run the declared tests." }],
    [{ answers: [
      { questionId: "resolution", optionIds: ["escalate"] },
      { questionId: "response", otherText: "The authorization choice is ambiguous." },
    ] }, { kind: "ESCALATE", reason: "The authorization choice is ambiguous." }],
  ])("reads only an addressed structured review-form result", (result, expected) => {
    expect(readQuestionReviewFormDecision(result)).toEqual(expected);
  });

  it("rejects prose, incomplete cards, and unknown form values", () => {
    expect(readQuestionReviewFormDecision("ANSWER: do it")).toBeNull();
    expect(readQuestionReviewFormDecision({ answers: [{ questionId: "resolution", optionIds: ["answer"] }] })).toBeNull();
    expect(readQuestionReviewFormDecision({ answers: [
      { questionId: "resolution", optionIds: ["maybe"] },
      { questionId: "response", otherText: "Unstructured decision" },
    ] })).toBeNull();
  });

  it.each([
    ["pending", undefined, { state: "pending" }],
    ["answered", { answers: [
      { questionId: "resolution", optionIds: ["answer"] },
      { questionId: "response", otherText: "Proceed." },
    ] }, { state: "answered", decision: { kind: "ANSWER", answer: "Proceed." } }],
    ["answered", { answers: [] }, { state: "answered", decision: "malformed" }],
  ])("classifies every native form status", (status, result, expected) => {
    expect(classifyNativeQuestionReview(status, result)).toEqual(expected);
  });

  it.each([
    ["expired", { outcome: "issue_closed" }, true],
    ["expired", { outcome: "timeout" }, false],
    ["answered", { outcome: "issue_closed" }, false],
    ["expired", null, false],
  ])("identifies only the native child-close bridge race", (status, result, expected) => {
    expect(isExpiredQuestionBridge(result, status)).toBe(expected);
  });

  it("waits for the reviewer child and never asks it to write the parent", () => {
    expect(reduceQuestionWorkflow(base())).toMatchObject({ action: "await_reviewer" });
  });

  it("relays an ANSWER only from the parent Jules run", () => {
    expect(reduceQuestionWorkflow(base({
      reviewerChild: { state: "answered", id: "child-1", answer: "Run the declared tests and submit the PR." },
    }))).toMatchObject({ action: "relay_answer", answer: "Run the declared tests and submit the PR." });
  });

  it("escalates reviewer uncertainty through the parent card", () => {
    expect(reduceQuestionWorkflow(base({
      reviewerChild: { state: "escalated", id: "child-1", reason: "Authorization choice is unspecified." },
    }))).toMatchObject({ action: "escalate_parent", reason: "Authorization choice is unspecified." });
  });

  it("does not recreate a card after a parent relay has been checkpointed", () => {
    expect(reduceQuestionWorkflow(base({ parentCard: { state: "answered", id: "card-1" } }))).toMatchObject({ action: "complete" });
  });
});
