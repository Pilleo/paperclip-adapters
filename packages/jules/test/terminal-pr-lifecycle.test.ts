import { describe, expect, it } from "vitest";
import { decideTerminalPrLifecycle } from "../src/server/terminal-pr-lifecycle.js";

describe("decideTerminalPrLifecycle", () => {
  it.each([
    ["completed PR with green CI enters native review", { providerState: "COMPLETED", hasPr: true, ciStatus: "success", hasRecoverySession: false }, "route_to_review"],
    ["completed PR with pending CI remains provider-owned", { providerState: "COMPLETED", hasPr: true, ciStatus: "pending", hasRecoverySession: false }, "await_ci"],
    ["completed PR with red CI starts branch-bound remediation", { providerState: "COMPLETED", hasPr: true, ciStatus: "failed", hasRecoverySession: false }, "start_pr_remediation"],
    ["completed PR with stalled CI never starts a second remediation", { providerState: "COMPLETED", hasPr: true, ciStatus: "stalled", hasRecoverySession: true }, "await_pr_remediation"],
    ["failed provider with a red PR starts one branch-bound remediation session", { providerState: "FAILED", hasPr: true, ciStatus: "failed", hasRecoverySession: false }, "start_pr_remediation"],
    ["failed provider never creates a second remediation session for the same PR", { providerState: "FAILED", hasPr: true, ciStatus: "failed", hasRecoverySession: true }, "await_pr_remediation"],
    ["terminal failure without a PR uses ordinary failure handling", { providerState: "FAILED", hasPr: false, ciStatus: "unknown", hasRecoverySession: false }, "normal_terminal_failure"],
    ["completion without a PR preserves the completion-confirmation flow", { providerState: "COMPLETED", hasPr: false, ciStatus: "unknown", hasRecoverySession: false }, "normal_completion_without_pr"],
  ] as const)("%s", (_description, input, expected) => {
    expect(decideTerminalPrLifecycle(input)).toEqual({ action: expected });
  });
});
