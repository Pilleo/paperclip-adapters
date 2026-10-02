import { describe, it, expect, vi } from "vitest";
import { rebasePrBranchLocally } from "../src/core/local-rebase.js";

describe("local PR integration validation", () => {
  it("holds missing branch identity before executing Git", async () => {
    const execFn = vi.fn();
    expect((await rebasePrBranchLocally({ prNumber: 1, mergeable: "CONFLICTING" }, "/repo", execFn as never)).ok).toBe(false);
    expect(execFn).not.toHaveBeenCalled();
  });

  it("bounds Git validation and preserves its error", async () => {
    const execFn = vi.fn().mockRejectedValue(new Error("invalid ref"));
    const result = await rebasePrBranchLocally({ prNumber: 1, mergeable: "CONFLICTING", headRefName: "bad ref", baseRefName: "main" }, "/repo", execFn as never);
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("invalid ref") });
    expect(execFn).toHaveBeenCalledWith("git", ["check-ref-format", "refs/heads/bad ref"], { cwd: "/repo", timeout: 30_000 });
  });
});
