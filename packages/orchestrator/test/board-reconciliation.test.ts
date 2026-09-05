import { describe, expect, it } from "vitest";
import { planBoardReconciliation, type BoardIssueSnapshot } from "../src/core/board-reconciliation.js";

const parent = (overrides: Partial<BoardIssueSnapshot> = {}): BoardIssueSnapshot => ({
  id: "parent-836",
  identifier: "MAZ-836",
  status: "in_progress",
  title: "Jules task",
  managed: true,
  assigneeKind: "orchestrator",
  executionRunLive: false,
  resumableMonitor: true,
  monitorExpired: false,
  nativeReviewInteraction: false,
  registeredOpenPullRequest: false,
  hasPullRequest: false,
  parentId: null,
  reviewGateKey: null,
  ...overrides,
});

describe("board reconciliation planner", () => {
  it("returns one resume command for a blocked Jules parent without a run", () => {
    expect(planBoardReconciliation([parent({ status: "blocked" })])).toEqual([
      expect.objectContaining({ action: "resume_provider", issueId: "parent-836" }),
    ]);
  });

  it("cancels duplicate review children but retains the authoritative gate", () => {
    const children = [1, 2, 3].map((n) => ({
      id: `child-${n}`,
      identifier: `MAZ-9${n}`,
      status: "blocked",
      title: "Review Jules plan (vibe)",
      managed: true,
      assigneeKind: "vibe_reviewer" as const,
      executionRunLive: false,
      resumableMonitor: false,
      nativeReviewInteraction: true,
      registeredOpenPullRequest: false,
      hasPullRequest: false,
      parentId: "parent-836",
      reviewGateKey: "jules:session-1:revision-1:vibe",
    }));
    expect(planBoardReconciliation([parent({ resumableMonitor: true }), ...children])).toEqual([
      expect.objectContaining({ action: "cancel_duplicate_child", issueId: "child-1" }),
      expect.objectContaining({ action: "cancel_duplicate_child", issueId: "child-2" }),
      expect.objectContaining({ action: "cancel_duplicate_child", issueId: "child-3" }),
    ]);
  });

  it("cancels all nonterminal children when historical revisions have no current gate", () => {
    const children = ["a", "b", "c"].map((suffix) => ({
      id: `child-${suffix}`,
      identifier: `MAZ-${suffix}`,
      status: "in_progress" as const,
      title: "Historical review child",
      managed: true,
      assigneeKind: "vibe_reviewer" as const,
      executionRunLive: true,
      resumableMonitor: false,
      nativeReviewInteraction: true,
      registeredOpenPullRequest: false,
      hasPullRequest: false,
      parentId: "parent-836",
      reviewGateKey: `jules:session-1:revision-${suffix}:vibe`,
    }));
    expect(planBoardReconciliation([parent(), ...children]).filter((command) => command.action === "cancel_duplicate_child")).toHaveLength(3);
  });

  it("repairs in-review work without PR or native interaction", () => {
    expect(planBoardReconciliation([parent({ id: "review-833", identifier: "MAZ-833", status: "in_review", resumableMonitor: false })])).toEqual([
      expect.objectContaining({ action: "return_to_todo", issueId: "review-833" }),
    ]);
  });

  it("returns an in-progress task without a run or monitor to todo", () => {
    expect(planBoardReconciliation([parent({ resumableMonitor: false })])).toEqual([
      expect.objectContaining({ action: "return_to_todo", issueId: "parent-836" }),
    ]);
  });

  it("returns an in-progress task with an expired monitor to todo", () => {
    expect(planBoardReconciliation([parent({ monitorExpired: true })])).toEqual([
      expect.objectContaining({ action: "return_to_todo", issueId: "parent-836" }),
    ]);
  });

  it("keeps an in-progress task with a live monitor", () => {
    expect(planBoardReconciliation([parent({ monitorExpired: false })])).toEqual([]);
  });

  it("produces a stable single recovery command across repeated heartbeats", () => {
    const snapshot = parent({ monitorExpired: true });
    const first = planBoardReconciliation([snapshot]);
    const second = planBoardReconciliation([snapshot]);
    expect(first).toEqual(second);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ action: "return_to_todo", issueId: "parent-836" });
  });

  it("does not mutate unmanaged historical work", () => {
    expect(planBoardReconciliation([parent({ id: "legacy", managed: false, status: "blocked", resumableMonitor: false })])).toEqual([]);
  });
});
