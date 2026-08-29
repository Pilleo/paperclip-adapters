import { describe, it, expect } from "vitest";
import { identifyStalledIssues } from "../src/core/stalled-session-reaper.js";
import { ParsedIssueMetadata } from "../src/core/types.js";

describe("Stalled Session Reaper", () => {
  const baseTimestamp = 1700000000000;

  const sampleIssues: ParsedIssueMetadata[] = [
    {
      id: "issue-1",
      identifier: "MAZ-1",
      title: "Active task with live heartbeat",
      status: "in_progress",
      updatedAt: new Date(baseTimestamp - 5 * 60 * 1000).toISOString(), // 5 min ago
    },
    {
      id: "issue-2",
      identifier: "MAZ-2",
      title: "Stalled task with no heartbeat",
      status: "in_progress",
      updatedAt: new Date(baseTimestamp - 20 * 60 * 1000).toISOString(), // 20 min ago
    },
    {
      id: "issue-3",
      identifier: "MAZ-3",
      title: "Completed task in review",
      status: "in_review",
      updatedAt: new Date(baseTimestamp - 60 * 60 * 1000).toISOString(), // 60 min ago
    },
    {
      id: "issue-4",
      identifier: "MAZ-4",
      title: "Active execution running in current tick",
      status: "in_progress",
      updatedAt: new Date(baseTimestamp - 30 * 60 * 1000).toISOString(), // 30 min ago but active
    },
  ];

  it("identifies stalled in_progress issues exceeding threshold without active execution", () => {
    const activeIssueIds = new Set(["issue-4"]);
    const stalled = identifyStalledIssues(sampleIssues, activeIssueIds, {
      stalledThresholdMs: 15 * 60 * 1000,
      now: () => baseTimestamp,
    });

    expect(stalled).toHaveLength(1);
    expect(stalled[0]?.issue.id).toBe("issue-2");
    expect(stalled[0]?.idleDurationMs).toBe(20 * 60 * 1000);
  });

  it("respects custom threshold", () => {
    const activeIssueIds = new Set<string>();
    const stalled = identifyStalledIssues(sampleIssues, activeIssueIds, {
      stalledThresholdMs: 4 * 60 * 1000, // 4 min threshold
      now: () => baseTimestamp,
    });

    expect(stalled.map((s) => s.issue.id)).toEqual(["issue-1", "issue-2", "issue-4"]);
  });
});
