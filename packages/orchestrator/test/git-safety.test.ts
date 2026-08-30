import { describe, it, expect } from "vitest";
import { evaluatePrMergeability, PrMergeabilityInfo } from "../src/core/git-safety.js";

describe("Pre-Merge Git Safety & Conflict Detector", () => {
  it("allows merge when PR is clean and mergeable", () => {
    const info: PrMergeabilityInfo = {
      prNumber: 526,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      headRefName: "feature-branch",
      baseRefName: "master",
    };

    const decision = evaluatePrMergeability(info);
    expect(decision.canMerge).toBe(true);
    expect(decision.isConflicting).toBe(false);
  });

  it("detects merge conflicts and recommends rebase", () => {
    const info: PrMergeabilityInfo = {
      prNumber: 526,
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      headRefName: "feature-branch",
      baseRefName: "master",
    };

    const decision = evaluatePrMergeability(info);
    expect(decision.canMerge).toBe(false);
    expect(decision.isConflicting).toBe(true);
    expect(decision.remediation).toContain("origin/master");
  });

  it("handles unknown/pending mergeability gracefully", () => {
    const info: PrMergeabilityInfo = {
      prNumber: 526,
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
      headRefName: "feature-branch",
      baseRefName: "master",
    };

    const decision = evaluatePrMergeability(info);
    expect(decision.canMerge).toBe(false);
    expect(decision.isConflicting).toBe(false);
  });
});
