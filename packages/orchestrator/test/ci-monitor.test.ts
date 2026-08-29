import { describe, it, expect } from "vitest";
import { evaluatePrCiChecks, formatCiAlertComment } from "../src/core/ci-monitor.js";

describe("ci-monitor Parameterized Suite", () => {
  it.each([
    {
      name: "all passing checks",
      checks: [
        { name: "test", conclusion: "SUCCESS" },
        { name: "lint", conclusion: "SUCCESS" },
      ],
      expectedState: "SUCCESS",
      expectedFailedCount: 0,
    },
    {
      name: "one failing check",
      checks: [
        { name: "test", conclusion: "SUCCESS" },
        { name: "lint", conclusion: "FAILURE" },
      ],
      expectedState: "FAILURE",
      expectedFailedCount: 1,
    },
    {
      name: "timed out check",
      checks: [
        { name: "integration", conclusion: "TIMED_OUT" },
      ],
      expectedState: "FAILURE",
      expectedFailedCount: 1,
    },
    {
      name: "queued / in progress checks",
      checks: [
        { name: "test", conclusion: "SUCCESS" },
        { name: "e2e", status: "IN_PROGRESS" },
      ],
      expectedState: "PENDING",
      expectedFailedCount: 0,
    },
    {
      name: "empty check list",
      checks: [],
      expectedState: "UNKNOWN",
      expectedFailedCount: 0,
    },
  ])("evaluates $name -> state: $expectedState", ({ checks, expectedState, expectedFailedCount }) => {
    const res = evaluatePrCiChecks("abc12345", checks);
    expect(res.state).toBe(expectedState);
    expect(res.failedChecks).toHaveLength(expectedFailedCount);
  });

  it("formats deduplicated alert comment with commit SHA comment tag", () => {
    const res = evaluatePrCiChecks("abc1234567890", [{ name: "gradle-check", conclusion: "FAILURE" }]);
    const comment = formatCiAlertComment(123, "https://github.com/Pilleo/mazewall/pull/123", res);
    expect(comment).toContain("gradle-check");
    expect(comment).toContain("<!-- mazewall:ci-failure-sha=abc1234567890 -->");
  });
});
