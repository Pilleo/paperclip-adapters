import { describe, expect, it } from "vitest";
import {
  decidePullRequestReconciliation,
  selectRegisteredPullRequestObservation,
  type PullRequestReconciliationInput,
} from "../src/core/pull-request-reconciliation.js";

const baseInput = (overrides: Partial<PullRequestReconciliationInput> = {}): PullRequestReconciliationInput => ({
  issueId: "issue-834",
  issueStatus: "in_review",
  workProduct: {
    id: "wp-834",
    status: "ready_for_review",
    reviewState: "none",
    url: "https://github.com/Pilleo/paperclip-adapters/pull/3",
  },
  pullRequest: {
    number: 3,
    url: "https://github.com/Pilleo/paperclip-adapters/pull/3",
    state: "MERGED",
    mergedAt: "2026-09-02T14:52:16Z",
  },
  mergeApproval: { id: "approval-834", status: "pending" },
  auditAlreadyRecorded: false,
  ...overrides,
});

describe("pull-request reconciliation reducer", () => {
  it.each([
    ["probes a blocked managed PR missing from bounded discovery", {
      registeredPrUrl: "https://github.com/Pilleo/repo/pull/10",
      discoveredPrUrls: new Set<string>(),
      hasPendingMergeApproval: false,
      orchestratorManaged: true,
      issueStatus: "blocked",
    }, { kind: "probe", reason: "managed_active_pr_outside_discovery" }],
    ["probes an in-review managed PR missing from bounded discovery", {
      registeredPrUrl: "https://github.com/Pilleo/repo/pull/10",
      discoveredPrUrls: new Set<string>(),
      hasPendingMergeApproval: false,
      orchestratorManaged: true,
      issueStatus: "in_review",
    }, { kind: "probe", reason: "managed_active_pr_outside_discovery" }],
    ["keeps historical pending merge approval cleanup probeable", {
      registeredPrUrl: "https://github.com/Pilleo/repo/pull/10",
      discoveredPrUrls: new Set<string>(),
      hasPendingMergeApproval: true,
      orchestratorManaged: false,
      issueStatus: "done",
    }, { kind: "probe", reason: "pending_merge_approval" }],
    ["skips a PR already present in discovery", {
      registeredPrUrl: "https://github.com/Pilleo/repo/pull/10",
      discoveredPrUrls: new Set(["https://github.com/Pilleo/repo/pull/10"]),
      hasPendingMergeApproval: true,
      orchestratorManaged: true,
      issueStatus: "blocked",
    }, { kind: "skip", reason: "already_discovered" }],
    ["does not probe an unmanaged blocked task without a merge gate", {
      registeredPrUrl: "https://github.com/Pilleo/repo/pull/10",
      discoveredPrUrls: new Set<string>(),
      hasPendingMergeApproval: false,
      orchestratorManaged: false,
      issueStatus: "blocked",
    }, { kind: "skip", reason: "not_a_merge_cleanup_candidate" }],
  ] as const)("%s", (_name, input, expected) => {
    expect(selectRegisteredPullRequestObservation(input)).toMatchObject(expected);
  });

  it("gives a merged PR terminal precedence over stale ready-for-review metadata", () => {
    expect(decidePullRequestReconciliation(baseInput())).toMatchObject({
      action: "COMPLETE_MERGED_PR",
      issueStatus: "done",
      workProductStatus: "merged",
      cancelMergeApprovalId: "approval-834",
    });
  });

  it("does not reopen a completed issue when the work product is stale", () => {
    expect(decidePullRequestReconciliation(baseInput({ issueStatus: "done" }))).toMatchObject({
      action: "NORMALIZE_MERGED_METADATA",
      issueStatus: "done",
      workProductStatus: "merged",
    });
  });

  it("continues reconciliation to invalidate a pending merge approval after metadata is settled", () => {
    expect(decidePullRequestReconciliation(baseInput({
      issueStatus: "done",
      workProduct: { id: "wp-834", status: "merged", reviewState: "approved", url: "https://github.com/Pilleo/paperclip-adapters/pull/3" },
      mergeApproval: { id: "approval-834", status: "pending" },
      auditAlreadyRecorded: true,
    }))).toMatchObject({
      action: "NORMALIZE_MERGED_METADATA",
      cancelMergeApprovalId: "approval-834",
    });
  });

  it("allows review recovery only for an explicitly open PR", () => {
    expect(decidePullRequestReconciliation(baseInput({
      issueStatus: "done",
      pullRequest: { number: 3, url: "https://github.com/Pilleo/paperclip-adapters/pull/3", state: "OPEN", mergedAt: null },
    }))).toMatchObject({ action: "RECOVER_OPEN_PR_REVIEW", issueStatus: "in_review" });
  });

  it("recovers an active issue when its registered PR is explicitly open", () => {
    expect(decidePullRequestReconciliation(baseInput({
      issueStatus: "in_progress",
      pullRequest: { number: 3, url: "https://github.com/Pilleo/paperclip-adapters/pull/3", state: "OPEN", mergedAt: null },
    }))).toMatchObject({ action: "RECOVER_OPEN_PR_REVIEW", issueStatus: "in_review" });
  });

  it("recovers a blocked issue with an explicitly open PR", () => {
    expect(decidePullRequestReconciliation(baseInput({
      issueStatus: "blocked",
      pullRequest: { number: 3, url: "https://github.com/Pilleo/paperclip-adapters/pull/3", state: "OPEN", mergedAt: null },
    })).action).toBe("RECOVER_OPEN_PR_REVIEW");
  });

  it("defers when GitHub state is unavailable instead of guessing", () => {
    expect(decidePullRequestReconciliation(baseInput({ pullRequest: undefined }))).toMatchObject({
      action: "DEFER",
    });
  });
});
