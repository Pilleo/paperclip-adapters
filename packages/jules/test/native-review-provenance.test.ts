import { describe, expect, it } from "vitest";
import {
  decideNativePlanReviewMigration,
  type NativePlanReviewMigrationInput,
  type NativePlanReviewMigrationDecision,
} from "../src/server/native-review-provenance.js";

describe("native review provenance", () => {
  it.each<{
    name: string;
    input: NativePlanReviewMigrationInput;
    expected: NativePlanReviewMigrationDecision;
  }>([
    {
      name: "keeps a pending parent card sourced by the parent run",
      input: { parentIssueId: "parent-1", reviewIssueId: "parent-1", sourceRunIssueId: "parent-1", status: "pending", reviewerRunState: "none" },
      expected: { action: "keep", location: "parent" },
    },
    {
      name: "keeps a pending parent card without source-run provenance",
      input: { parentIssueId: "parent-1", reviewIssueId: "parent-1", sourceRunIssueId: null, status: "pending", reviewerRunState: "none" },
      expected: { action: "keep", location: "parent" },
    },
    {
      name: "migrates a pending child card sourced by the parent run",
      input: { parentIssueId: "parent-1", reviewIssueId: "child-1", sourceRunIssueId: "parent-1", status: "pending", reviewerRunState: "none" },
      expected: { action: "migrate_to_parent", legacyReviewIssueId: "child-1", targetIssueId: "parent-1" },
    },
    {
      name: "waits for an active child reviewer run before migrating",
      input: { parentIssueId: "parent-1", reviewIssueId: "child-1", sourceRunIssueId: "parent-1", status: "pending", reviewerRunState: "active" },
      expected: { action: "await_active_run", location: "legacy_child" },
    },
    {
      name: "keeps a valid pending legacy child card sourced by the child run",
      input: { parentIssueId: "parent-1", reviewIssueId: "child-1", sourceRunIssueId: "child-1", status: "pending", reviewerRunState: "none" },
      expected: { action: "keep", location: "legacy_child" },
    },
    {
      name: "consumes an answered legacy child card without migration",
      input: { parentIssueId: "parent-1", reviewIssueId: "child-1", sourceRunIssueId: "parent-1", status: "answered", reviewerRunState: "terminal" },
      expected: { action: "consume_existing", location: "legacy_child" },
    },
    {
      name: "fails closed when a pending child card has no source identity",
      input: { parentIssueId: "parent-1", reviewIssueId: "child-1", sourceRunIssueId: null, status: "pending", reviewerRunState: "none" },
      expected: { action: "fail_closed", reason: "missing_child_source_identity" },
    },
    {
      name: "fails closed when source provenance belongs to an unrelated issue",
      input: { parentIssueId: "parent-1", reviewIssueId: "child-1", sourceRunIssueId: "other-1", status: "pending", reviewerRunState: "none" },
      expected: { action: "fail_closed", reason: "unrelated_source_issue" },
    },
  ])("$name", ({ input, expected }) => {
    expect(decideNativePlanReviewMigration(input)).toEqual(expected);
  });

  it.each([
    { parentIssueId: "", reviewIssueId: "child-1", sourceRunIssueId: "parent-1", status: "pending", reviewerRunState: "none" },
    { parentIssueId: "parent-1", reviewIssueId: "", sourceRunIssueId: "parent-1", status: "pending", reviewerRunState: "none" },
    { parentIssueId: "parent-1", reviewIssueId: "child-1", sourceRunIssueId: "", status: "pending", reviewerRunState: "none" },
    { parentIssueId: "parent-1", reviewIssueId: "child-1", sourceRunIssueId: "parent-1", status: "cancelled", reviewerRunState: "none" },
    { parentIssueId: "parent-1", reviewIssueId: "child-1", sourceRunIssueId: "parent-1", status: "pending", reviewerRunState: "unknown" },
  ])("fails closed for malformed provenance %#", (input) => {
    expect(decideNativePlanReviewMigration(input as NativePlanReviewMigrationInput)).toEqual({
      action: "fail_closed",
      reason: "invalid_provenance",
    });
  });
});
