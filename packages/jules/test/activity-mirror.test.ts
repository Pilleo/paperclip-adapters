import { describe, it, expect, vi } from "vitest";
import { activityScanPageLimit, listAllActivities, mirrorNewActivities } from "../src/server/activity-mirror.js";
import { JulesClient } from "../src/server/jules-client.js";
import { JulesAdapterSessionV1 } from "../src/server/session.js";

const addComment = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../src/server/paperclip-client.js", () => ({ addJulesActivityComment: addComment }));

describe("activity-mirror", () => {
  it("uses one recent activity page while a Jules question already has an adjudication owner", () => {
    const session = {
      pendingInteraction: {
        type: "agent_adjudication",
        julesActivityId: "question-1",
      },
    } as JulesAdapterSessionV1;

    expect(activityScanPageLimit(session)).toBe(1);
  });

  it("keeps the deep bounded scan when no provider question is already owned", () => {
    expect(activityScanPageLimit({} as JulesAdapterSessionV1)).toBe(20);
  });

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

  it("stops when Jules returns a repeated pagination token", async () => {
    const client = {
      getActivities: vi.fn()
        .mockResolvedValueOnce({
          activities: [{ id: "act-1", createTime: "2026-08-30T00:00:00.000Z" }],
          nextPageToken: "same-token",
        })
        .mockResolvedValueOnce({
          activities: [{ id: "act-2", createTime: "2026-08-30T00:01:00.000Z" }],
          nextPageToken: "same-token",
        }),
    } as unknown as JulesClient;

    const res = await listAllActivities(client, "session-1");

    expect(res).toHaveLength(2);
    expect(client.getActivities).toHaveBeenCalledTimes(2);
  });

  it("scans beyond five pages so an unresolved provider question is not hidden by later churn", async () => {
    const pages = Array.from({ length: 6 }, (_, index) => ({
      activities: index === 0
        ? [{ id: "later-plan", createTime: "2026-08-30T00:10:00.000Z" }]
        : index === 5
          ? [{ id: "question-1", createTime: "2026-08-30T00:05:00.000Z", agentMessaged: { agentMessage: "How should I proceed?" } }]
          : [{ id: `activity-${index}`, createTime: `2026-08-30T00:0${index + 1}:00.000Z` }],
      ...(index < 5 ? { nextPageToken: `page-${index + 1}` } : {}),
    }));
    const client = {
      getActivities: vi.fn().mockImplementation(async (_session: string, token?: string) => {
        const page = token ? Number(token.replace("page-", "")) : 0;
        return pages[page];
      }),
    } as unknown as JulesClient;

    const res = await listAllActivities(client, "session-1");

    expect(res.map((activity) => activity.id)).toContain("question-1");
    expect(client.getActivities).toHaveBeenCalledTimes(6);
  });

  it("requests the provider maximum page size so recent feedback is reachable before the bounded scan ends", async () => {
    const client = {
      getActivities: vi.fn().mockImplementation(async (_session: string, token?: string, pageSize?: number) => {
        const page = token ? Number(token.replace("page-", "")) : 0;
        const pagesRequired = pageSize === 100 ? 13 : 21;
        return {
          activities: page === pagesRequired - 1
            ? [{ id: "latest-question", createTime: "2026-09-06T20:17:18.249Z", agentMessaged: { agentMessage: "Which monitor API clears terminal state?" } }]
            : [{ id: `activity-${page}`, createTime: "2026-09-06T20:00:00.000Z" }],
          nextPageToken: page + 1 < pagesRequired ? `page-${page + 1}` : undefined,
        };
      }),
    } as unknown as JulesClient;

    const activities = await listAllActivities(client, "session-1");

    expect(activities.map((activity) => activity.id)).toContain("latest-question");
    expect(client.getActivities).toHaveBeenCalledWith("session-1", undefined, 100);
  });

  it("stops when pagination tokens change but the returned page does not", async () => {
    const client = {
      getActivities: vi.fn()
        .mockResolvedValueOnce({
          activities: [{ id: "act-1", createTime: "2026-08-30T00:00:00.000Z" }],
          nextPageToken: "token-2",
        })
        .mockResolvedValue({
          activities: [{ id: "act-1", createTime: "2026-08-30T00:00:00.000Z" }],
          nextPageToken: "token-3",
        }),
    } as unknown as JulesClient;

    await expect(listAllActivities(client, "session-1")).resolves.toHaveLength(1);
    expect(client.getActivities).toHaveBeenCalledTimes(2);
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

  it("does not acknowledge an activity when Paperclip comment delivery fails", async () => {
    addComment.mockRejectedValueOnce(new Error("temporary Paperclip failure"));
    const client = { getActivities: vi.fn().mockResolvedValue({
      activities: [{ id: "question-1", createTime: "2026-08-30T00:05:00.000Z", agentMessaged: { agentMessage: "Which option?" } }],
    }) } as unknown as JulesClient;
    const session: JulesAdapterSessionV1 = {
      version: 1, paperclipIssueId: "issue-1", promptHash: "hash-1", repository: "repo", source: "src",
      baseBranch: "main", phase: "RUNNING", attempt: 1, failedSessions: [], createdAt: "2026-08-30T00:00:00.000Z",
    };
    await mirrorNewActivities(client, session, "issue-1", "token", "run-1", vi.fn().mockResolvedValue(undefined));
    expect(session.deliveredActivityIds ?? []).not.toContain("question-1");
    expect(session.activityCheckpoint).toBeUndefined();
  });

  it("checkpoints outbound user-message echoes without mirroring them", async () => {
    addComment.mockReset();
    addComment.mockResolvedValue(undefined);
    const client = { getActivities: vi.fn().mockResolvedValue({
      activities: [
        {
          id: "outbound-1",
          createTime: "2026-08-30T00:05:00.000Z",
          userMessaged: { userMessage: "Continue with the assigned workflow." },
        },
        {
          id: "agent-1",
          createTime: "2026-08-30T00:06:00.000Z",
          agentMessaged: { agentMessage: "I am continuing." },
        },
      ],
    }) } as unknown as JulesClient;
    const session: JulesAdapterSessionV1 = {
      version: 1, paperclipIssueId: "issue-1", promptHash: "hash-1", repository: "repo", source: "src",
      baseBranch: "main", phase: "RUNNING", attempt: 1, failedSessions: [], createdAt: "2026-08-30T00:00:00.000Z",
    };

    await mirrorNewActivities(client, session, "issue-1", "token", "run-1", vi.fn().mockResolvedValue(undefined));

    expect(addComment).toHaveBeenCalledTimes(1);
    expect(addComment).toHaveBeenCalledWith("issue-1", "agent-1", expect.any(String), undefined, "token", "run-1");
    expect(session.deliveredActivityIds).toEqual(["outbound-1", "agent-1"]);
  });
});
