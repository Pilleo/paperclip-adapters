import { describe, expect, it } from "vitest";
import { buildDisposableCanaryBootstrapIssue } from "../src/core/real-e2e-canary-fixture.js";

describe("real provider E2E canary fixture", () => {
  it("creates a completed non-blocking bootstrap anchor", () => {
    expect(buildDisposableCanaryBootstrapIssue("project-1")).toMatchObject({
      projectId: "project-1",
      status: "done",
      assigneeAgentId: null,
      executionPolicy: null,
      executionState: null,
    });
  });
});
