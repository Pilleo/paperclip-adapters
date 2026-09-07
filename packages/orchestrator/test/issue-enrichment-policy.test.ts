import { describe, expect, it } from "vitest";
import { needsFullIssueRecord } from "../src/core/issue-enrichment-policy.js";

describe("issue enrichment policy", () => {
  it("fetches execution state for blocked monitor issues", () => {
    expect(needsFullIssueRecord("blocked")).toBe(true);
  });

  it("also enriches terminal and review issues", () => {
    expect(needsFullIssueRecord("done")).toBe(true);
    expect(needsFullIssueRecord("in_review")).toBe(true);
  });

  it("keeps ordinary backlog listings compact", () => {
    expect(needsFullIssueRecord("todo")).toBe(false);
    expect(needsFullIssueRecord("in_progress")).toBe(false);
  });
});
