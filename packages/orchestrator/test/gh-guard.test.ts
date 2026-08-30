import { describe, it, expect } from "vitest";
import { evaluateGhCommandAllowed, createGhShimScript } from "../src/core/gh-guard.js";

describe("GitHub CLI Read-Only Command Guard", () => {
  it("allows read-only gh inspection commands", () => {
    expect(evaluateGhCommandAllowed(["pr", "view", "526"]).allowed).toBe(true);
    expect(evaluateGhCommandAllowed(["pr", "diff", "526"]).allowed).toBe(true);
    expect(evaluateGhCommandAllowed(["pr", "checks", "526"]).allowed).toBe(true);
    expect(evaluateGhCommandAllowed(["auth", "status"]).allowed).toBe(true);
    expect(evaluateGhCommandAllowed(["run", "view", "123"]).allowed).toBe(true);
  });

  it("strictly blocks gh pr comment and gh issue comment commands", () => {
    const prComment = evaluateGhCommandAllowed(["pr", "comment", "526", "--body", "some comment"]);
    expect(prComment.allowed).toBe(false);
    expect(prComment.reason).toContain("Modifying GitHub comments is blocked");

    const issueComment = evaluateGhCommandAllowed(["issue", "comment", "526", "--body", "some comment"]);
    expect(issueComment.allowed).toBe(false);
    expect(issueComment.reason).toContain("Modifying GitHub comments is blocked");

    const prReviewComment = evaluateGhCommandAllowed(["pr", "review", "526", "--comment", "-b", "feedback"]);
    expect(prReviewComment.allowed).toBe(false);
  });

  it("generates executable bash shim script that intercepts mutating comment calls", () => {
    const shim = createGhShimScript();
    expect(shim).toContain("#!/usr/bin/env bash");
    expect(shim).toContain("pr comment");
    expect(shim).toContain("issue comment");
    expect(shim).toContain("exec \"$REAL_GH\"");
  });
});
