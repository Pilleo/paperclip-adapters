import { describe, expect, it } from "vitest";
import { decideReviewSession, findReviewCardBinding, nativeReviewRecoveryWakeKey } from "../src/core/review-session-state.js";

const run = (patch: Record<string, unknown> = {}) => ({
  id: "run-1",
  agentId: "terra-1",
  status: "running",
  issueId: "issue-1",
  interactionId: null,
  ...patch,
});

describe("native review session state", () => {
  it("derives a stable recovery key from the exact failed run and card", () => {
    expect(nativeReviewRecoveryWakeKey("terra-1", "issue-1", "card-1", "run-failed"))
      .toBe("native-review-recovery:v1:terra-1:issue-1:card-1:run-failed");
  });
  it("binds a pending canonical card to its live reviewer run without executionState", () => {
    expect(findReviewCardBinding({
      issueId: "issue-1",
      reviewerAgentId: "terra-1",
      cards: [{ id: "card-1", status: "pending", addresseeAgentId: "terra-1", idempotencyKey: "pr-review:v13:issue-1:pr:sha:terra" }],
      runs: [run({ interactionId: "card-1" })],
    })).toMatchObject({ card: { id: "card-1" }, run: { id: "run-1" } });
  });

  it("binds retry-attempt cards, not only base idempotency keys", () => {
    expect(findReviewCardBinding({
      issueId: "issue-1",
      reviewerAgentId: "terra-1",
      cards: [{ id: "card-attempt-21", status: "pending", addresseeAgentId: "terra-1", idempotencyKey: "pr-review:v13:issue-1:pr:sha:terra:attempt:21" }],
      runs: [run({ id: "run-attempt-21", interactionId: "card-attempt-21" })],
    })).toMatchObject({ card: { id: "card-attempt-21" }, run: { id: "run-attempt-21" } });
  });

  it("does not bind an unrelated reviewer run", () => {
    expect(findReviewCardBinding({
      issueId: "issue-1",
      reviewerAgentId: "terra-1",
      cards: [{ id: "card-1", status: "pending", addresseeAgentId: "terra-1", idempotencyKey: "pr-review:v13:issue-1:pr:sha:terra" }],
      runs: [run({ issueId: "other-issue", interactionId: null })],
    })).toMatchObject({ card: { id: "card-1" } });
  });

  it("does not treat an unbound same-issue reviewer run as a native-card run", () => {
    expect(findReviewCardBinding({
      issueId: "issue-1",
      reviewerAgentId: "terra-1",
      cards: [{ id: "card-1", status: "pending", addresseeAgentId: "terra-1", idempotencyKey: "pr-review:v13:issue-1:pr:sha:terra" }],
      runs: [run({ interactionId: null })],
    })).toEqual({ card: { id: "card-1", status: "pending", addresseeAgentId: "terra-1", idempotencyKey: "pr-review:v13:issue-1:pr:sha:terra" } });
  });
  it("waits for the live reviewer run after its card is cancelled", () => {
    expect(decideReviewSession({
      issueId: "issue-1",
      reviewerAgentId: "terra-1",
      interactionId: "card-1",
      runs: [run({ interactionId: "card-1" })],
      interactions: [{ id: "card-1", status: "cancelled" }],
    })).toEqual({ action: "await_run", runId: "run-1" });
  });

  it("allocates a new attempt only after the reviewer run is terminal", () => {
    expect(decideReviewSession({
      issueId: "issue-1",
      reviewerAgentId: "terra-1",
      interactionId: "card-1",
      runs: [run({ status: "succeeded" })],
      interactions: [{ id: "card-1", status: "cancelled" }],
    })).toEqual({ action: "protocol_failure", reason: "reviewer run ended without a structured verdict" });
  });

  it("requests one recovery wake when the bound reviewer run ended without answering its pending card", () => {
    expect(decideReviewSession({
      issueId: "issue-1",
      reviewerAgentId: "terra-1",
      interactionId: "card-1",
      runs: [run({ id: "run-failed", status: "failed", interactionId: "card-1" })],
      interactions: [{ id: "card-1", status: "pending" }],
    })).toEqual({
      action: "recover",
      runId: "run-failed",
      reason: "reviewer run ended without a structured verdict",
    });
  });

  it("does not recover an unrelated terminal run", () => {
    expect(decideReviewSession({
      issueId: "issue-1",
      reviewerAgentId: "terra-1",
      interactionId: "card-1",
      runs: [run({ id: "other-run", status: "failed", interactionId: "other-card" })],
      interactions: [{ id: "card-1", status: "pending" }],
    })).toEqual({ action: "dispatch" });
  });
});
