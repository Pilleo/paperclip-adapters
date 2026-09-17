import { describe, expect, it } from "vitest";
import {
  assertAuthoritativeCanaryChain,
  buildCanaryA,
  buildCanaryB,
  buildCanaryC,
  buildDisposableCanaryBootstrapIssue,
} from "../src/core/real-e2e-canary-fixture.js";

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

  it("builds a native A -> B -> C chain with disjoint scopes", () => {
    expect(buildCanaryA("project-1", "run-1")).toMatchObject({
      projectId: "project-1",
      status: "todo",
      description: expect.stringContaining("<!-- paperclip-adapters:e2e-run:run-1 -->"),
    });
    expect(buildCanaryB("project-1", "run-1", "a")).toMatchObject({
      blockedByIssueIds: ["a"],
      description: expect.stringContaining("decrement.js"),
    });
    expect(buildCanaryC("project-1", "run-1", "b")).toMatchObject({
      blockedByIssueIds: ["b"],
      description: expect.stringContaining("is-zero.js"),
    });
  });

  it("accepts only authoritative blockedBy edges", () => {
    expect(assertAuthoritativeCanaryChain(
      { id: "a", blockedBy: [] },
      { id: "b", blockedBy: [{ id: "a" }] },
      { id: "c", blockedBy: [{ id: "b" }] },
    )).toEqual({ ok: true });
    expect(assertAuthoritativeCanaryChain(
      { id: "a", blockedBy: [] },
      { id: "b", blockedByIssueIds: ["a"] },
      { id: "c", blockedBy: [{ id: "b" }] },
    )).toEqual({ ok: false, reason: "b_missing_authoritative_blocker" });
  });
});
