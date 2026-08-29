import { describe, it, expect } from "vitest";
import { evaluatePrCiChecks, formatCiAlertComment } from "../src/core/ci-monitor.js";

describe("ci-monitor", () => {
  it("evaluates all passing checks as SUCCESS", () => {
    const checks = [
      { name: "test", conclusion: "SUCCESS" },
      { name: "lint", conclusion: "SUCCESS" },
    ];
    const res = evaluatePrCiChecks("abc12345", checks);
    expect(res.state).toBe("SUCCESS");
    expect(res.failedChecks).toHaveLength(0);
  });

  it("evaluates failing check as FAILURE", () => {
    const checks = [
      { name: "test", conclusion: "SUCCESS" },
      { name: "lint", conclusion: "FAILURE" },
    ];
    const res = evaluatePrCiChecks("abc12345", checks);
    expect(res.state).toBe("FAILURE");
    expect(res.failedChecks).toContain("lint");
  });

  it("evaluates in-progress check as PENDING", () => {
    const checks = [
      { name: "test", conclusion: "SUCCESS" },
      { name: "integration", status: "IN_PROGRESS" },
    ];
    const res = evaluatePrCiChecks("abc12345", checks);
    expect(res.state).toBe("PENDING");
  });

  it("formats deduplicated alert comment with commit SHA comment tag", () => {
    const res = evaluatePrCiChecks("abc1234567890", [{ name: "gradle-check", conclusion: "FAILURE" }]);
    const comment = formatCiAlertComment(123, "https://github.com/Pilleo/mazewall/pull/123", res);
    expect(comment).toContain("gradle-check");
    expect(comment).toContain("<!-- mazewall:ci-failure-sha=abc1234567890 -->");
  });
});
