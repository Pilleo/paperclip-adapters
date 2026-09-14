import { describe, expect, it } from "vitest";
import {
  buildImplementationRejectionWake,
  resolveImplementationOwner,
} from "../src/core/implementation-owner.js";

describe("implementation owner resolution", () => {
  const managed = new Set(["jules", "vibe"]);

  it.each([
    ["uses persisted work-product ownership", { metadataAgentId: "vibe", currentAssigneeId: "luna" }, "vibe"],
    ["uses a current managed implementation assignee before review", { metadataAgentId: null, currentAssigneeId: "vibe" }, "vibe"],
    ["rejects an unmanaged persisted identity", { metadataAgentId: "attacker", currentAssigneeId: "luna" }, null],
    ["does not guess from worker ordering", { metadataAgentId: null, currentAssigneeId: "luna" }, null],
  ] as const)("%s", (_name, input, expected) => {
    expect(resolveImplementationOwner({ ...input, managedWorkerIds: managed })).toBe(expected);
  });
});

describe("implementation rejection wake", () => {
  it.each(["luna_review", "terra_review"] as const)("builds a provider-neutral %s rejection handoff", (stage) => {
    const wake = buildImplementationRejectionWake({
      issueId: "issue-1",
      identifier: "MAZ-1241",
      headSha: "abc123",
      stage,
      feedback: {
        kind: "native_review",
        interactionId: "review-card-1",
        reason: "Preserve the historical NDJSON output shape.",
      },
    });

    expect(wake.reason).toContain("answered native PR review card");
    expect(wake.reason).toContain("MAZ-1241");
    expect(wake.reason).toContain("review-card-1");
    expect(wake.reason).toContain("Preserve the historical NDJSON output shape.");
    expect(wake.reason).not.toMatch(/Jules|Vibe/i);
    expect(wake.idempotencyKey).toBe(`orchestrator:implementation-reconcile:issue-1:abc123:${stage}:review-card-1`);
    expect(wake.epoch).toEqual({
      version: 1,
      issueId: "issue-1",
      headSha: "abc123",
      stage,
      feedbackId: "review-card-1",
    });
  });

  it("projects a rejected operator merge approval without pretending it is a review card", () => {
    const wake = buildImplementationRejectionWake({
      issueId: "issue-1",
      identifier: "MAZ-1241",
      headSha: "abc123",
      stage: "operator_approval",
      feedback: { kind: "operator_approval", approvalId: "approval-1" },
    });

    expect(wake.reason).toContain("merge approval approval-1 was rejected");
    expect(wake.reason).not.toContain("review card");
    expect(wake.idempotencyKey).toBe("orchestrator:implementation-reconcile:issue-1:abc123:operator_approval:approval-1");
  });
});
