import { describe, expect, it } from "vitest";
import { isExecutionAdmissionHeld } from "../src/core/execution-admission.js";

describe("execution admission", () => {
  it.each([
    ["missing", {}, false],
    ["null", { executionBlocker: null }, false],
    ["typed blocker", { executionBlocker: { cause: "legacy_execution_requires_reconciliation" } }, true],
    ["unknown future blocker", { executionBlocker: { cause: "future_server_hold" } }, true],
    ["malformed non-null blocker", { executionBlocker: "redacted" }, true],
  ])("treats %s projection as held=%s", (_name, rawIssue, expected) => {
    expect(isExecutionAdmissionHeld(rawIssue)).toBe(expected);
  });
});
