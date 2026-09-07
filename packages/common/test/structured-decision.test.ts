import { describe, expect, it } from "vitest";
import {
  parseStructuredDecisionCapability,
  selectDecisionTransport,
  validateStructuredDecision,
} from "../src/structured-decision.js";

describe("structured decision capability", () => {
  it.each([
    ["codex", ["mcp_tool"], "mcp_tool"],
    ["remote-provider", ["adapter_callback"], "adapter_callback"],
    ["acp-provider", ["acp_tool", "adapter_callback"], "acp_tool"],
  ] as const)("selects an advertised transport without inspecting provider %s", (_provider, transports, expected) => {
    const capability = parseStructuredDecisionCapability({
      version: 1,
      transports,
      decisionKinds: ["pull_request_review"],
    });

    expect(selectDecisionTransport(capability, "pull_request_review", ["mcp_tool", "acp_tool", "adapter_callback"]))
      .toEqual({ status: "supported", transport: expected });
  });

  it("fails closed before invocation when no structured transport is available", () => {
    const capability = parseStructuredDecisionCapability({
      version: 1,
      transports: ["adapter_callback"],
      decisionKinds: ["plan_review"],
    });

    expect(selectDecisionTransport(capability, "pull_request_review", ["adapter_callback"]))
      .toEqual({ status: "unsupported", reason: "decision_kind_not_supported" });
  });

  it.each([
    [{ kind: "review", verdict: "approve" }, true],
    [{ kind: "review", verdict: "reject", reason: "The implementation violates the contract." }, true],
    [{ kind: "review", verdict: "reject" }, false],
    [{ kind: "question", verdict: "answer", answer: "Use the project workspace." }, true],
    [{ kind: "question", verdict: "uncertain", reason: "Repository ownership is ambiguous." }, true],
    [{ kind: "question", verdict: "answer", answer: "   " }, false],
    ["all good", false],
  ])("accepts only complete structured outcomes %#", (value, valid) => {
    expect(validateStructuredDecision(value) !== null).toBe(valid);
  });
});
