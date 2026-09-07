import { describe, it, expect } from "vitest";
import { isManagedWorker, resolveManagedFleet } from "../src/core/managed-workers.js";

describe("managed worker ownership fence", () => {
  const orchestratorId = "orch-1";
  const managedJules = {
    id: "jules-orch",
    name: "[Orchestrated] Jules Async Worker",
    adapterType: "jules",
    reportsTo: orchestratorId,
    metadata: { managedBy: "paperclip-orchestrator", workerKey: "jules" },
  };
  const independentJules = {
    id: "jules-indie",
    name: "Async software developer",
    adapterType: "jules",
    reportsTo: "ceo-1",
    metadata: {},
  };

  it("does not treat independent Jules/Vibe/AGY as orchestrator-owned", () => {
    expect(isManagedWorker(managedJules, orchestratorId)).toBe(true);
    expect(isManagedWorker(independentJules, orchestratorId)).toBe(false);
  });

  it("never selects independent agents as the Jules/Vibe lane", () => {
    const fleet = resolveManagedFleet(
      [managedJules, independentJules, { id: "orch-1", name: "Task Orchestrator", adapterType: "orchestrator" }],
      orchestratorId
    );
    expect(fleet.julesAgentId).toBe("jules-orch");
    expect(fleet.managedIds.has("jules-indie")).toBe(false);
  });

  it("prefers a capable managed reviewer over a stale configured legacy id", () => {
    const legacy = {
      id: "luna-legacy",
      name: "[Orchestrated] Luna Fast Reviewer",
      adapterType: "codex_local",
      reportsTo: orchestratorId,
      metadata: { managedBy: "paperclip-orchestrator", workerKey: "luna_reviewer" },
    };
    const replacement = {
      id: "luna-capable",
      name: "[Orchestrated] Luna Fast Reviewer [v10]",
      adapterType: "codex_local",
      reportsTo: orchestratorId,
      metadata: {
        managedBy: "paperclip-orchestrator",
        workerKey: "luna_reviewer",
        structuredDecisionCapability: {
          version: 1,
          transports: ["mcp_tool"],
          decisionKinds: ["pull_request_review"],
        },
      },
    };

    const fleet = resolveManagedFleet(
      [managedJules, legacy, replacement],
      orchestratorId,
      { lunaReviewerAgentId: legacy.id },
    );

    expect(fleet.lunaReviewerAgentId).toBe(replacement.id);
  });
});
