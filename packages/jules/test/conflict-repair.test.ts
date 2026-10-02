import { describe, expect, it } from "vitest";
import { conflictRepairStartingBranch } from "../src/server/conflict-repair.js";

const assignment = { version: 1, attemptId: "repair", companyId: "company", issueId: "source", agentId: "chosen",
  prUrl: "https://github.com/acme/repo/pull/1", headRef: "existing-pr", baseRef: "main" };
const description = `<!-- paperclip-conflict-repair:v1\n${JSON.stringify(assignment)}\n-->\nResolve this existing PR.`;
describe("remote conflict repair branch", () => {
  it("starts the configured remote resolver on the existing PR branch", () => {
    expect(conflictRepairStartingBranch(description, "chosen", "company", "acme/repo", "main")).toBe("existing-pr");
  });
  it("keeps ordinary implementation on its configured base branch", () => {
    expect(conflictRepairStartingBranch("Implement feature", "chosen", "company", "acme/repo", "main")).toBe("main");
  });
  it("rejects foreign resolver or repository identity instead of opening a different PR", () => {
    expect(() => conflictRepairStartingBranch(description, "other", "company", "acme/repo", "main")).toThrow();
    expect(() => conflictRepairStartingBranch(description, "chosen", "company", "wrong/repo", "main")).toThrow();
  });
});
