import { describe, expect, it } from "vitest";
import { planNoPrFollowup, type NoPrFollowupSnapshot } from "../src/core/no-pr-followup.js";

const taskFile = "stress-stress-20260929-pilot-b-numbers.js";
const input: NoPrFollowupSnapshot = {
  issueId: "81b75464-37a4-4b08-bdbb-6257a1f80cc1",
  sessionId: "9473602080744226872",
  durableSessionId: "9473602080744226872",
  julesAgentId: "jules-agent",
  assigneeAgentId: "jules-agent",
  issueStatus: "blocked",
  providerState: "COMPLETED",
  prRequired: true,
  noPrConfirmation: "pending",
  products: [],
  remotePullRequests: [],
  targetFiles: [taskFile, "stress-stress-20260929-pilot-b-03.test.js"],
  siblings: [{ id: "2248bede-a343-42d5-84e7-6ca350cc3c7d", status: "in_review",
    targetFiles: [taskFile, "stress-stress-20260929-pilot-b-04.test.js"],
    prProductStatus: "ready_for_review", githubPrState: "OPEN",
    prUrl: "https://github.com/Pilleo/paperclip-adapters-e2e-20260923-vanilla-review/pull/6",
    headSha: "7e1fb1412ae5f85892a36f738e93c356b2e7f137" }],
};

describe("one-shot PR-required Jules follow-up", () => {
  it("holds while an approved sibling has an open PR for the same declared file", () => {
    expect(planNoPrFollowup(input)).toEqual({ kind: "held", reason: "shared_file_not_merged" });
  });

  it("allows only the explicitly approved original-session follow-up while the exact sibling PR stays open", () => {
    const approval = { siblingIssueId: "2248bede-a343-42d5-84e7-6ca350cc3c7d",
      prUrl: "https://github.com/Pilleo/paperclip-adapters-e2e-20260923-vanilla-review/pull/6",
      headSha: "7e1fb1412ae5f85892a36f738e93c356b2e7f137" };
    const decision = planNoPrFollowup({ ...input, sharedFileOverride: approval,
      siblings: [{ ...input.siblings[0]!, status: "in_progress" }] });
    expect(decision.kind).toBe("ready");
    if (decision.kind !== "ready") return;
    expect(decision.prompt).toContain("open exactly one pull request");
    expect(decision.prompt).toContain("pull/6");
    expect(decision.prompt).toContain("separate branch");
    expect(decision.prompt).toContain("Do not merge");
    expect(planNoPrFollowup({ ...input, issueStatus: "in_progress", sharedFileOverride: approval,
      siblings: [{ ...input.siblings[0]!, status: "in_progress" }] }).kind).toBe("ready");
    expect(planNoPrFollowup({ ...input, sharedFileOverride: { ...approval, headSha: "b".repeat(40) } })).toEqual({
      kind: "held", reason: "shared_file_not_merged",
    });
    expect(planNoPrFollowup({ ...input, sharedFileOverride: approval,
      siblings: [...input.siblings, { id: "second-conflict", status: "in_progress", targetFiles: [taskFile] }] }))
      .toEqual({ kind: "held", reason: "shared_file_not_merged" });
  });

  it("permits one same-session commit/push/PR request after the sibling's standard merge is verified", () => {
    const decision = planNoPrFollowup({ ...input, siblings: [{ ...input.siblings[0]!, status: "done",
      prProductStatus: "merged", githubPrState: "MERGED" }] });
    expect(decision.kind).toBe("ready");
    if (decision.kind !== "ready") return;
    expect(decision.prompt).toContain("commit and push");
    expect(decision.prompt).toContain("open exactly one pull request");
    expect(decision.prompt).toContain("latest master");
    expect(decision.prompt).toContain("same Jules session");
    expect(decision.prompt).toContain(taskFile);
    expect(decision.marker).toMatch(/^paperclip:pr-required-followup:[a-f0-9]{64}$/);
  });

  it("never messages an uncertain or already-delivered provider effect", () => {
    const clear = { ...input, siblings: [{ ...input.siblings[0]!, status: "done", prProductStatus: "merged",
      githubPrState: "MERGED" }] };
    expect(planNoPrFollowup({ ...clear, remotePullRequests: ["https://github.com/Pilleo/repo/pull/9"] }).kind).toBe("held");
    expect(planNoPrFollowup({ ...clear, providerState: "IN_PROGRESS" }).kind).toBe("held");
    expect(planNoPrFollowup({ ...clear, durableSessionId: "another-session" }).kind).toBe("held");
    expect(planNoPrFollowup({ ...clear, noPrConfirmation: "accepted" }).kind).toBe("held");
    expect(planNoPrFollowup({ ...clear, prRequired: false }).kind).toBe("held");
  });
});
