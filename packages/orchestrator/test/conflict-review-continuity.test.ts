import { describe, expect, it } from "vitest";
import { reviewHeadAfterConflictResolution } from "../src/core/conflict-review-continuity.js";
import { observePrReviewChild, prReviewChildDescription, projectPrChildVerdict } from "../src/core/pr-review-child.js";

const reviewed = "a".repeat(40);
const resolved = "c".repeat(40);
const prUrl = "https://github.com/acme/repo/pull/1";
const identity = { companyId: "company", issueId: "source", prUrl, currentHeadSha: resolved };
const repair = { version: 1, attemptId: "attempt", companyId: "company", projectId: "project",
  issueId: "source", productId: "product", prUrl, headRef: "feature", baseRef: "main",
  previousHeadSha: reviewed, reviewHeadSha: reviewed, baseSha: "b".repeat(40), phase: "resolved",
  agentId: "chosen", repairTaskId: "repair", repairRunId: "repair-run", resolvedHeadSha: resolved,
  cardRequested: false, cardId: null, candidateHeadSha: null };
const metadata = { headSha: resolved, conflictRecovery: repair };

describe("review continuity after conflict resolution", () => {
  it("retains the actual reviewed head for the verified repair without relabeling a verdict", () => {
    expect(reviewHeadAfterConflictResolution(metadata, identity)).toBe(reviewed);
    expect(metadata.headSha).toBe(resolved);
    expect(repair.reviewHeadSha).toBe(reviewed);
  });

  it("does not extend continuity to an unrelated subsequent code revision", () => {
    expect(reviewHeadAfterConflictResolution({ ...metadata, headSha: "d".repeat(40) },
      { ...identity, currentHeadSha: "d".repeat(40) })).toBe("d".repeat(40));
  });

  it("rejects mismatched scope or missing agent-run provenance", () => {
    expect(() => reviewHeadAfterConflictResolution(metadata, { ...identity, issueId: "another" })).toThrow();
    expect(() => reviewHeadAfterConflictResolution({ ...metadata,
      conflictRecovery: { ...repair, repairRunId: null } }, identity)).toThrow();
  });

  it("still attests the original addressed child verdict against a repaired primary product", async () => {
    const childIdentity = { version: 1 as const, companyId: "company", parentIssueId: "source", prUrl,
      headSha: reviewed, stage: "luna" as const, reviewerAgentId: "luna", bootstrapAgentId: "orchestrator" };
    const api = { get: async (route: string) => {
      if (route === "/issues/source") return { id: "source", companyId: "company", status: "in_review", assigneeAgentId: null };
      if (route === "/issues/source/work-products") return [{ type: "pull_request", url: prUrl, isPrimary: true,
        status: "ready_for_review", metadata }];
      if (route === "/issues/review") return { id: "review", companyId: "company", parentId: "source", status: "done",
        assigneeAgentId: "luna", createdByAgentId: "orchestrator", description: prReviewChildDescription(childIdentity) };
      if (route === "/issues/review/interactions") return [{ id: "original-card", kind: "request_item_verdicts", status: "answered",
        idempotencyKey: `pr-review:v13:review:${prUrl}:${reviewed}:luna`, addresseeAgentId: "luna",
        sourceRunId: "bootstrap", resolvedByRunId: "reviewer", result: { outcome: "resolved", complete: true,
          items: [{ id: "pull_request", verdict: "approve" }] } }];
      if (route === "/heartbeat-runs/bootstrap") return { id: "bootstrap", companyId: "company", agentId: "orchestrator", status: "succeeded", contextSnapshot: { issueId: "review" } };
      if (route === "/heartbeat-runs/reviewer") return { id: "reviewer", companyId: "company", agentId: "luna", status: "succeeded", contextSnapshot: { issueId: "review" } };
      throw new Error(`Unexpected ${route}`);
    }, post: async () => { throw new Error("Re-review is forbidden"); }, patch: async () => { throw new Error("Verdict rewriting is forbidden"); } };
    const proof = await observePrReviewChild({ identity: childIdentity, childId: "review", api });
    if (proof.kind !== "answered") throw new Error("Original card did not attest");
    const card = projectPrChildVerdict(childIdentity, proof);
    expect(card.id).toBe("original-card");
    expect(card.idempotencyKey).toContain(reviewed);
    expect(card.idempotencyKey).not.toContain(resolved);
  });
});
