import { describe, it, expect } from "vitest";
import { checkWorkspaceConsistency, evaluateWorkspaceConsistency } from "../src/core/consistency.js";

describe("Deep Workspace Consistency Tests", () => {
  it("evaluates clean and uncommitted states correctly", () => {
    const clean = evaluateWorkspaceConsistency({
      isClean: true,
      currentBranch: "master",
      headSha: "abc1234",
    });
    expect(clean.isClean).toBe(true);
    expect(clean.warning).toBeUndefined();

    const dirty = evaluateWorkspaceConsistency({
      isClean: false,
      currentBranch: "feature/landlock",
      headSha: "def5678",
    });
    expect(dirty.isClean).toBe(false);
    expect(dirty.warning).toContain("uncommitted changes");
  });

  it("checks real workspace consistency using current working directory", async () => {
    // without repoUrl and defaultRef, checkWorkspaceConsistency now explicitly fails closed
    const report = await checkWorkspaceConsistency(process.cwd());
    expect(typeof report.currentBranch).toBe("string");
    expect(typeof report.headSha).toBe("string");
    expect(report.isConsistent).toBe(false);
    expect(report.status).toBe("unhealthy");
    expect(report.observation.type).toBe("missing_repo_url");
  });
});
