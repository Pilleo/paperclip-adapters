import { describe, it, expect, vi } from "vitest";
import { listAllActivities, mirrorNewActivities } from "../src/server/activity-mirror.js";
import { JulesClient } from "../src/server/jules-client.js";
import { JulesAdapterSessionV1 } from "../src/server/session.js";

describe("activity-mirror", () => {
  it("paginates and retrieves all activities", async () => {
    const client = {
      getActivities: vi.fn()
        .mockResolvedValueOnce({
          activities: [{ id: "act-1", createTime: "2026-08-30T00:00:00.000Z" }],
          nextPageToken: "token-2",
        })
        .mockResolvedValueOnce({
          activities: [{ id: "act-2", createTime: "2026-08-30T00:01:00.000Z" }],
        }),
    } as unknown as JulesClient;

    const res = await listAllActivities(client, "session-1");
    expect(res).toHaveLength(2);
    expect(res[0].id).toBe("act-1");
    expect(res[1].id).toBe("act-2");
  });

  it("mirrors new activities after checkpoint and logs them", async () => {
    const client = {
      getActivities: vi.fn().mockResolvedValue({
        activities: [
          { id: "act-old", createTime: "2026-08-30T00:00:00.000Z" },
          { id: "act-new", createTime: "2026-08-30T00:05:00.000Z", description: "Thinking..." },
        ],
      }),
    } as unknown as JulesClient;

    const session: JulesAdapterSessionV1 = {
      version: 1,
      paperclipIssueId: "issue-1",
      promptHash: "hash-1",
      repository: "repo",
      source: "src",
      baseBranch: "main",
      phase: "RUNNING",
      attempt: 1,
      failedSessions: [],
      createdAt: "2026-08-30T00:00:00.000Z",
      activityCheckpoint: "2026-08-30T00:02:00.000Z",
    };

    const onLog = vi.fn().mockResolvedValue(undefined);
    const mirrored = await mirrorNewActivities(client, session, "issue-1", "token", "run-1", onLog);
    expect(mirrored).toHaveLength(2);
    expect(session.deliveredActivityIds).toContain("act-new");
    expect(onLog).toHaveBeenCalled();
  });
});
