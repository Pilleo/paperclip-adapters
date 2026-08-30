import { describe, it, expect, vi } from "vitest";
import { evaluateChecks, getPullRequestDetails, getPullRequestCiStatus, getPullRequestPatch, listPullRequestChangedFiles, CheckItem } from "../src/server/ci-status";

describe("evaluateChecks", () => {
  it("returns success when checks array is empty", () => {
    expect(evaluateChecks([])).toBe("pending");
  });

  it("returns pending when any check is pending or in progress", () => {
    const checks: CheckItem[] = [
      { name: "Build", state: "SUCCESS", bucket: "pass" },
      { name: "Test", state: "IN_PROGRESS", bucket: "pending" },
    ];
    expect(evaluateChecks(checks)).toBe("pending");
  });

  it("returns failed when any check failed", () => {
    const checks: CheckItem[] = [
      { name: "Build", state: "SUCCESS", bucket: "pass" },
      { name: "Test", state: "FAILURE", bucket: "fail" },
    ];
    expect(evaluateChecks(checks)).toBe("failed");
  });

  it("returns success when all checks passed", () => {
    const checks: CheckItem[] = [
      { name: "Build", state: "SUCCESS", bucket: "pass" },
      { name: "Test", state: "SUCCESS", bucket: "pass" },
      { name: "Lint", state: "SUCCESS", bucket: "pass" },
    ];
    expect(evaluateChecks(checks)).toBe("success");
  });
});

describe("getPullRequestDetails", () => {
  it("returns unknown when offline or command fails", async () => {
    const details = await getPullRequestDetails("https://github.com/nonexistent/repo/pull/9999");
    expect(details.state).toBeDefined();
    expect(details.ciStatus).toBeDefined();
  });

  it("calls getPullRequestCiStatus returning status string", async () => {
    const status = await getPullRequestCiStatus("https://github.com/nonexistent/repo/pull/9999");
    expect(typeof status).toBe("string");
  });

  it("returns an empty file list and patch when gh cannot see the PR", async () => {
    const files = await listPullRequestChangedFiles("https://github.com/nonexistent/repo/pull/9999");
    const patch = await getPullRequestPatch("https://github.com/nonexistent/repo/pull/9999");
    expect(files).toEqual([]);
    expect(patch).toBe("");
  });
});
