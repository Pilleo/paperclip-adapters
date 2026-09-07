import { describe, expect, it } from "vitest";
import { evaluateJulesIssueOwnership } from "../src/server/session-ownership.js";

describe("Jules restored-session ownership", () => {
  it("allows mutations while Jules still owns the issue", () => {
    expect(evaluateJulesIssueOwnership({ issue: { assigneeAgentId: "jules", status: "blocked" }, julesAgentId: "jules" })).toBe("owned");
  });

  it("recognizes reassignment and terminal status as a clean handoff", () => {
    expect(evaluateJulesIssueOwnership({ issue: { assigneeAgentId: "orchestrator", status: "blocked" }, julesAgentId: "jules" })).toBe("transferred");
    expect(evaluateJulesIssueOwnership({ issue: { assigneeAgentId: "jules", status: "done" }, julesAgentId: "jules" })).toBe("transferred");
  });

  it("clears missing issues but retries infrastructure failures", () => {
    expect(evaluateJulesIssueOwnership({ fetchFailed: { status: 404 }, julesAgentId: "jules" })).toBe("missing");
    expect(evaluateJulesIssueOwnership({ fetchFailed: { status: 503 }, julesAgentId: "jules" })).toBe("unknown");
  });
});
