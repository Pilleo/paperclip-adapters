import { describe, expect, it } from "vitest";
import { hasNativeReviewVerdictAttestation } from "../src/server/native-review-attestation.js";

const verdictEvent = {
  type: "item.completed",
  item: {
    type: "mcp_tool_call",
    server: "paperclip_review",
    tool: "submit_native_review_verdict",
    status: "completed",
    result: {
      structured_content: {
        interactionId: "card-1",
        verdict: "reject",
      },
    },
  },
};

describe("native reviewer verdict attestation", () => {
  it("accepts only the exact structured verdict from the addressed reviewer run", () => {
    expect(hasNativeReviewVerdictAttestation({
      reviewerAgentId: "luna-1",
      reviewerIssueId: "child-1",
      interactionId: "card-1",
      verdict: "reject",
      runs: [{
        agentId: "luna-1",
        status: "succeeded",
        contextSnapshot: { taskId: "child-1" },
        resultJson: { stdout: `${JSON.stringify(verdictEvent)}\n` },
      }],
    })).toBe(true);
  });

  it("accepts an exact receipt from a parent-owned native review run", () => {
    expect(hasNativeReviewVerdictAttestation({
      reviewerAgentId: "luna-1",
      reviewerIssueId: "parent-1",
      interactionId: "card-1",
      verdict: "reject",
      runs: [{
        agentId: "luna-1",
        status: "succeeded",
        contextSnapshot: { issueId: "parent-1" },
        resultJson: { stdout: `${JSON.stringify(verdictEvent)}\n` },
      }],
    })).toBe(true);
  });

  it("rejects a receipt from another parent-owned review", () => {
    expect(hasNativeReviewVerdictAttestation({
      reviewerAgentId: "luna-1",
      reviewerIssueId: "parent-1",
      interactionId: "card-1",
      verdict: "reject",
      runs: [{
        agentId: "luna-1",
        status: "succeeded",
        contextSnapshot: { issueId: "parent-2" },
        resultJson: { stdout: `${JSON.stringify(verdictEvent)}\n` },
      }],
    })).toBe(false);
  });

  it.each([
    ["a board answer without a reviewer run", []],
    ["a different reviewer", [{ agentId: "terra-1", status: "succeeded", contextSnapshot: { taskId: "child-1" }, resultJson: { stdout: `${JSON.stringify(verdictEvent)}\n` } }]],
    ["a run for another child", [{ agentId: "luna-1", status: "succeeded", contextSnapshot: { taskId: "child-2" }, resultJson: { stdout: `${JSON.stringify(verdictEvent)}\n` } }]],
    ["a different interaction", [{ agentId: "luna-1", status: "succeeded", contextSnapshot: { taskId: "child-1" }, resultJson: { stdout: `${JSON.stringify({
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: "paperclip_review",
        tool: "submit_native_review_verdict",
        status: "completed",
        result: { structured_content: { interactionId: "card-2", verdict: "reject" } },
      },
    })}\n` } }]],
    ["an unstructured reviewer message", [{ agentId: "luna-1", status: "succeeded", contextSnapshot: { taskId: "child-1" }, resultJson: { stdout: "I reject this plan\n" } }]],
  ])("rejects %s", (_label, runs) => {
    expect(hasNativeReviewVerdictAttestation({
      reviewerAgentId: "luna-1",
      reviewerIssueId: "child-1",
      interactionId: "card-1",
      verdict: "reject",
      runs,
    })).toBe(false);
  });
});
