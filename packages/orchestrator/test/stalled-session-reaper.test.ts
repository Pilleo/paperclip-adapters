import { describe, it, expect } from "vitest";
import { identifyStalledIssues } from "../src/core/stalled-session-reaper.js";
import { ParsedIssueMetadata } from "../src/core/types.js";

describe("Stalled Session Reaper", () => {
  const baseTimestamp = 1700000000000;

  const vibe = "managed-vibe";
  const jules = "managed-jules";
  const independent = "independent-jules";
  const managedAgentIds = new Set([vibe, jules]);
  const managedJulesIds = new Set([jules]);

  const sampleIssues: ParsedIssueMetadata[] = [
    {
      id: "issue-1",
      identifier: "MAZ-1",
      title: "Active task with live heartbeat",
      status: "in_progress",
      assigneeAgentId: vibe,
      updatedAt: new Date(baseTimestamp - 5 * 60 * 1000).toISOString(),
    },
    {
      id: "issue-2",
      identifier: "MAZ-2",
      title: "Stalled task with no heartbeat",
      status: "in_progress",
      assigneeAgentId: vibe,
      updatedAt: new Date(baseTimestamp - 20 * 60 * 1000).toISOString(),
    },
    {
      id: "issue-3",
      identifier: "MAZ-3",
      title: "Completed task in review",
      status: "in_review",
      assigneeAgentId: vibe,
      updatedAt: new Date(baseTimestamp - 60 * 60 * 1000).toISOString(),
    },
    {
      id: "issue-4",
      identifier: "MAZ-4",
      title: "Active execution running in current tick",
      status: "in_progress",
      assigneeAgentId: vibe,
      updatedAt: new Date(baseTimestamp - 30 * 60 * 1000).toISOString(),
    },
    {
      id: "issue-jules",
      identifier: "MAZ-J",
      title: "Managed Jules still coding after 20m",
      status: "in_progress",
      assigneeAgentId: jules,
      updatedAt: new Date(baseTimestamp - 20 * 60 * 1000).toISOString(),
    },
    {
      id: "issue-indie",
      identifier: "MAZ-I",
      title: "Independent Jules workflow",
      status: "in_progress",
      assigneeAgentId: independent,
      updatedAt: new Date(baseTimestamp - 20 * 60 * 1000).toISOString(),
    },
  ];

  it("identifies stalled in_progress issues exceeding threshold without active execution", () => {
    const activeIssueIds = new Set(["issue-4"]);
    const stalled = identifyStalledIssues(sampleIssues, activeIssueIds, {
      stalledThresholdMs: 15 * 60 * 1000,
      managedAgentIds,
      managedJulesIds,
      now: () => baseTimestamp,
    });

    expect(stalled).toHaveLength(1);
    expect(stalled[0]?.issue.id).toBe("issue-2");
    expect(stalled[0]?.idleDurationMs).toBe(20 * 60 * 1000);
  });

  it("respects custom threshold", () => {
    const activeIssueIds = new Set<string>();
    const stalled = identifyStalledIssues(sampleIssues, activeIssueIds, {
      stalledThresholdMs: 4 * 60 * 1000,
      managedAgentIds,
      managedJulesIds,
      now: () => baseTimestamp,
    });

    expect(stalled.map((s) => s.issue.id)).toEqual(["issue-1", "issue-2", "issue-4"]);
  });

  it("does not reap independent agents or managed Jules before the session deadline", () => {
    const stalled = identifyStalledIssues(sampleIssues, new Set(), {
      stalledThresholdMs: 15 * 60 * 1000,
      managedAgentIds,
      managedJulesIds,
      now: () => baseTimestamp,
    });
    expect(stalled.map((s) => s.issue.id)).toEqual(["issue-2", "issue-4"]);
  });
});
