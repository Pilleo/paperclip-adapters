import { describe, expect, it } from "vitest";
import { evaluateReviewerEligibility, evaluateStructuredReviewerEligibility, isReviewerEligibilityFailure, planNativeReviewDispatch } from "../src/core/reviewer-eligibility.js";

describe("reviewer eligibility", () => {
  it.each(["idle", "running", "busy"])("accepts %s as invokable", (status) => {
    expect(evaluateReviewerEligibility(status)).toEqual({ kind: "eligible" });
  });

  it.each([undefined, "paused", "error", "offline"])("fails closed for %s", (status) => {
    expect(evaluateReviewerEligibility(status)).toMatchObject({ kind: "unavailable" });
  });

  it("recognizes Paperclip paused-agent 422s", () => {
    expect(isReviewerEligibilityFailure(422, "addresseeAgentId must reference an invokable agent; reason: paused")).toBe(true);
    expect(isReviewerEligibilityFailure(422, "title is required")).toBe(false);
  });

  it.each([
    ["codex_local", ["mcp_tool"], "mcp_tool"],
    ["custom_remote", ["adapter_callback"], "adapter_callback"],
    ["acp_adapter", ["acp_tool"], "acp_tool"],
  ] as const)("accepts %s through its declared provider-neutral capability", (_adapter, transports, transport) => {
    expect(evaluateStructuredReviewerEligibility("idle", {
      version: 1,
      transports,
      decisionKinds: ["pull_request_review"],
    }, "pull_request_review")).toEqual({ kind: "eligible", transport });
  });

  it.each([
    [undefined, "structured decision capability is missing"],
    [{ version: 1, transports: ["adapter_callback"], decisionKinds: ["plan_review"] }, "decision_kind_not_supported"],
    [{ version: 1, transports: ["comment"], decisionKinds: ["pull_request_review"] }, "structured decision capability is invalid"],
  ])("fails before waking a reviewer whose capability cannot carry the decision", (capability, reason) => {
    expect(evaluateStructuredReviewerEligibility("idle", capability, "pull_request_review"))
      .toEqual({ kind: "unavailable", reason });
  });

  it("plans a native Luna card only for a managed, invokable structured reviewer", () => {
    expect(planNativeReviewDispatch({
      targetAgentId: "luna-1",
      managedAgentIds: new Set(["luna-1"]),
      status: "idle",
      capability: { version: 1, transports: ["mcp_tool"], decisionKinds: ["pull_request_review"] },
    })).toEqual({ kind: "dispatch", targetAgentId: "luna-1", transport: "mcp_tool" });
  });

  it.each([
    [undefined, new Set(["luna-1"]), "idle", { version: 1, transports: ["mcp_tool"], decisionKinds: ["pull_request_review"] }, "missing_target"],
    ["luna-1", new Set<string>(), "idle", { version: 1, transports: ["mcp_tool"], decisionKinds: ["pull_request_review"] }, "unmanaged_target"],
    ["luna-1", new Set(["luna-1"]), "paused", { version: 1, transports: ["mcp_tool"], decisionKinds: ["pull_request_review"] }, "reviewer_unavailable"],
    ["luna-1", new Set(["luna-1"]), "idle", undefined, "reviewer_unavailable"],
  ] as const)("does not silently abandon a non-dispatchable native reviewer", (targetAgentId, managedAgentIds, status, capability, kind) => {
    expect(planNativeReviewDispatch({ targetAgentId, managedAgentIds, status, capability }))
      .toMatchObject({ kind });
  });
});
