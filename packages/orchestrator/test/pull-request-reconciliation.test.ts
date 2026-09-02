import { describe, expect, it } from "vitest";
import {
  decidePullRequestReconciliation,
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

  it("is a no-op after the merged metadata and audit are already settled", () => {
    expect(decidePullRequestReconciliation(baseInput({
      issueStatus: "done",
      workProduct: { id: "wp-834", status: "merged", reviewState: "approved", url: "https://github.com/Pilleo/paperclip-adapters/pull/3" },
      mergeApproval: { id: "approval-834", status: "pending" },
      auditAlreadyRecorded: true,
    }))).toMatchObject({ action: "NOOP" });
  });

  it("allows review recovery only for an explicitly open PR", () => {
    expect(decidePullRequestReconciliation(baseInput({
      issueStatus: "done",
      pullRequest: { number: 3, url: "https://github.com/Pilleo/paperclip-adapters/pull/3", state: "OPEN", mergedAt: null },
    }))).toMatchObject({ action: "RECOVER_OPEN_PR_REVIEW", issueStatus: "in_review" });
  });

  it("defers when GitHub state is unavailable instead of guessing", () => {
    expect(decidePullRequestReconciliation(baseInput({ pullRequest: undefined }))).toMatchObject({
      action: "DEFER",
    });
  });
});
