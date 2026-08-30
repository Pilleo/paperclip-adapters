import { describe, it, expect, vi } from "vitest";
import { rebasePrBranchLocally } from "../src/core/local-rebase.js";

describe("local PR rebase", () => {
  it("fetches, rebases onto origin/base, and force-with-lease pushes", async () => {
    const execFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const result = await rebasePrBranchLocally(
      { prNumber: 12, mergeable: "CONFLICTING", headRefName: "feat", baseRefName: "master" },
      "/repo",
      execFn as never
    );
    expect(result.ok).toBe(true);
    expect(execFn).toHaveBeenCalledWith("git", ["rebase", "origin/master"], { cwd: "/repo" });
    expect(execFn).toHaveBeenCalledWith("git", ["push", "--force-with-lease", "origin", "feat"], { cwd: "/repo" });
  });

  it("aborts rebase and reports failure without claiming success", async () => {
    const execFn = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "rebase" && args[1] !== "--abort") throw new Error("conflict");
      return { stdout: "", stderr: "" };
    });
    const result = await rebasePrBranchLocally(
      { prNumber: 12, mergeable: "CONFLICTING", headRefName: "feat", baseRefName: "master" },
      "/repo",
      execFn as never
    );
    expect(result.ok).toBe(false);
    expect(execFn).toHaveBeenCalledWith("git", ["rebase", "--abort"], { cwd: "/repo" });
  });
});
