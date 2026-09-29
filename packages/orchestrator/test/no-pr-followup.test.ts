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
    prProductStatus: "ready_for_review", githubPrState: "OPEN" }],
};

describe("one-shot PR-required Jules follow-up", () => {
  it("holds while an approved sibling has an open PR for the same declared file", () => {
    expect(planNoPrFollowup(input)).toEqual({ kind: "held", reason: "shared_file_not_merged" });
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
