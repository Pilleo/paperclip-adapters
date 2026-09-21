import { describe, it, expect } from "vitest";
import {
  evaluateChecks,
  getPullRequestDetails,
  getPullRequestCiStatus,
  getPullRequestPatch,
  listPullRequestChangedFiles,
  type CheckItem,
} from "../src/server/ci-status";

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

  it("returns stalled when an in-progress check exceeds the bounded CI wait", () => {
    const now = Date.parse("2026-09-09T10:00:00.000Z");
    const checks: CheckItem[] = [
      { name: "Start disposable Paperclip server", state: "IN_PROGRESS", bucket: "pending", startedAt: "2026-09-09T08:00:00.000Z" },
    ];

    expect(evaluateChecks(checks, now)).toBe("stalled");
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
  it("uses the run-scoped GitHub environment for every inspection command", async () => {
    const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const commandRunner = async (
      args: readonly string[],
      options: { env: NodeJS.ProcessEnv },
    ) => {
      calls.push({ args, env: options.env });
      if (args[1] === "view") {
        return {
          stdout: JSON.stringify({
            state: "OPEN",
            mergedAt: null,
            mergeable: "MERGEABLE",
            headRefOid: "a".repeat(40),
            headRefName: "jules-42",
          }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify([{ name: "CI", bucket: "pass", state: "SUCCESS" }]),
        stderr: "",
      };
    };

    const details = await getPullRequestDetails("https://github.com/o/r/pull/42", {
      env: { PAPERCLIP_GITHUB_BROKER_TOKEN: "run-scoped-token", PATH: "/broker/bin" },
      commandRunner,
    });

    expect(details).toMatchObject({
      state: "OPEN",
      merged: false,
      ciStatus: "success",
      inspectionStatus: "observed",
      headRefName: "jules-42",
    });
    expect(calls.map(({ args }) => args.slice(0, 2))).toEqual([["pr", "view"], ["pr", "checks"]]);
    expect(calls.every(({ env }) => env.PAPERCLIP_GITHUB_BROKER_TOKEN === "run-scoped-token")).toBe(true);
    expect(calls.every(({ env }) => env.PATH === "/broker/bin")).toBe(true);
  });

  it("fails closed when the brokered GitHub command is unavailable", async () => {
    const details = await getPullRequestDetails("https://github.com/o/r/pull/42", {
      commandRunner: async () => {
        throw Object.assign(new Error("authentication required"), { stderr: "authentication required" });
      },
    });

    expect(details).toMatchObject({
      state: "UNKNOWN",
      merged: false,
      ciStatus: "unknown",
      inspectionStatus: "unavailable",
      unavailableReason: "authentication",
    });
  });

  it("uses the same brokered command contract for status, file, and patch lookups", async () => {
    const commandRunner = async (args: readonly string[]) => {
      if (args.includes("--name-only")) return { stdout: "packages/jules/src/server/ci-status.ts\n", stderr: "" };
      if (args[1] === "checks") return { stdout: JSON.stringify([{ bucket: "pass", state: "SUCCESS" }]), stderr: "" };
      if (args[1] === "view") return { stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
      return { stdout: "diff --git a/a b/a\n", stderr: "" };
    };
    const options = { env: { PAPERCLIP_GITHUB_BROKER_TOKEN: "run-scoped-token" }, commandRunner };

    const status = await getPullRequestCiStatus("https://github.com/o/r/pull/42", options);
    const files = await listPullRequestChangedFiles("https://github.com/o/r/pull/42", options);
    const patch = await getPullRequestPatch("https://github.com/o/r/pull/42", options);

    expect(status).toBe("success");
    expect(files).toEqual(["packages/jules/src/server/ci-status.ts"]);
    expect(patch).toContain("diff --git");
  });

  it("returns empty informational scope inputs when the broker cannot inspect the PR", async () => {
    const commandRunner = async () => {
      throw new Error("GitHub launcher unavailable");
    };
    const files = await listPullRequestChangedFiles("https://github.com/o/r/pull/42", { commandRunner });
    const patch = await getPullRequestPatch("https://github.com/o/r/pull/42", { commandRunner });
    expect(files).toEqual([]);
    expect(patch).toBe("");
  });
});
