import { describe, expect, it, vi } from "vitest";
import { dispatchStructuredDecision } from "../src/structured-decision-dispatch.js";

const capability = {
  version: 1 as const,
  transports: ["adapter_callback", "acp_tool"] as const,
  decisionKinds: ["pull_request_review"] as const,
};

describe("structured decision transport dispatch", () => {
  it("invokes exactly the negotiated transport and returns its validated result", async () => {
    const callback = vi.fn().mockResolvedValue({ kind: "review", verdict: "approve" });
    const acp = vi.fn().mockResolvedValue({ kind: "review", verdict: "reject", reason: "wrong transport" });

    await expect(dispatchStructuredDecision({
      capability,
      decisionKind: "pull_request_review",
      preference: ["adapter_callback", "acp_tool"],
      payload: { issueId: "issue-1" },
      transports: { adapter_callback: callback, acp_tool: acp },
    })).resolves.toEqual({ status: "submitted", transport: "adapter_callback", decision: { kind: "review", verdict: "approve" } });
    expect(callback).toHaveBeenCalledWith({ decisionKind: "pull_request_review", payload: { issueId: "issue-1" } });
    expect(acp).not.toHaveBeenCalled();
  });

  it.each([
    ["missing handler", {}, "transport_handler_missing"],
    ["prose result", { adapter_callback: async () => "approved" }, "invalid_structured_decision"],
  ] as const)("fails closed on %s", async (_label, transports, reason) => {
    await expect(dispatchStructuredDecision({
      capability: { ...capability, transports: ["adapter_callback"] },
      decisionKind: "pull_request_review",
      preference: ["adapter_callback"],
      payload: {},
      transports,
    })).resolves.toEqual({ status: "failed", reason });
  });
});
