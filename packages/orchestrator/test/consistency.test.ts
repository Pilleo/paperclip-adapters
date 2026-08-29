import { describe, it, expect } from "vitest";
import { evaluateWorkspaceConsistency } from "../src/core/consistency.js";

describe("Workspace Consistency Module", () => {
  it("evaluates clean workspace as consistent without warnings", () => {
    const report = evaluateWorkspaceConsistency({
      isClean: true,
      currentBranch: "fast-master",
      headSha: "abc1234",
    });
    expect(report.isClean).toBe(true);
    expect(report.isConsistent).toBe(true);
    expect(report.currentBranch).toBe("fast-master");
    expect(report.warning).toBeUndefined();
  });

  it("handles dirty workspace gracefully with informational warning", () => {
    const report = evaluateWorkspaceConsistency({
      isClean: false,
      currentBranch: "master",
      headSha: "def5678",
    });
    expect(report.isClean).toBe(false);
    expect(report.isConsistent).toBe(true);
    expect(report.warning).toContain("uncommitted changes");
  });
});
