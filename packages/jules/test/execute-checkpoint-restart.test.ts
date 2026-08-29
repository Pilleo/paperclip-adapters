import { beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "../src/server/execute";
import { JulesClient } from "../src/server/jules-client";
import { sessionCodec } from "../src/server/session";

vi.mock("../src/server/jules-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/server/jules-client")>();
  const MockClient = vi.fn();
  MockClient.prototype.getSession = vi.fn();
  MockClient.prototype.getActivities = vi.fn();
  MockClient.prototype.createSession = vi.fn();
  return { ...original, JulesClient: MockClient };
});

describe("activity checkpoint restart recovery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delivers a reordered paginated activity exactly once across heartbeats", async () => {
    const progress = {
      id: "activity-2",
      createTime: "2026-08-08T10:02:00.000Z",
      userMessaged: { userMessage: "Working through the lifecycle." },
    };
    const bashEvidence = {
      id: "activity-1",
      createTime: "2026-08-08T10:01:00.000Z",
      userMessaged: { userMessage: "all checks passed" },
    };
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      name: "sessions/session-1" as any,
      id: "session-1" as any,
      state: "IN_PROGRESS",
    });
    vi.mocked(JulesClient.prototype.getActivities).mockImplementation(async (_id, pageToken) =>
      pageToken
        ? { activities: [bashEvidence, progress] }
        : { activities: [progress], nextPageToken: "page-2" });

    const postedBodies: string[] = [];
    global.fetch = vi.fn(async (_url, init) => {
      if (init?.method === "POST") postedBodies.push(String(init.body));
      return { ok: true, status: 200, text: async () => "" } as Response;
    });

    const initialSession = sessionCodec.encode({
      version: 1,
      paperclipIssueId: "issue-1",
      promptHash: "hash",
      promptHashVersion: 2,
      repository: "owner/repo",
      source: "sources/github/owner/repo",
      baseBranch: "main",
      phase: "RUNNING",
      sessionId: "session-1",
      julesSessionId: "session-1",
      attempt: 1,
      failedSessions: [],
      createdAt: "2026-08-08T10:00:00.000Z",
    } as any)!;
    const base = {
      agent: { adapterConfig: { source: "sources/github/owner/repo", repository: "owner/repo", baseBranch: "main" } },
      config: { env: { JULES_API_KEY: "key" } },
      context: { task: { id: "issue-1", title: "Lifecycle" } },
      runtime: { sessionParams: initialSession },
      runId: "run-1",
      authToken: "token",
      onLog: vi.fn(),
    } as any;

    const firstAbort = new AbortController();
    setTimeout(() => firstAbort.abort(), 10);
    const first = await execute({ ...base, abortSignal: firstAbort.signal });
    const checkpointed = sessionCodec.decode(first.sessionParams)!;
    expect(postedBodies).toHaveLength(2);
    expect(postedBodies.join("\n")).toContain("Working through the lifecycle.");
    expect(postedBodies.join("\n")).toContain("all checks passed");
    expect(checkpointed.deliveredActivityIds).toEqual(["activity-1", "activity-2"]);
    expect(checkpointed.activityCheckpoint).toEqual({
      createTime: "2026-08-08T10:02:00.000Z",
      id: "activity-2",
    });
    expect(JulesClient.prototype.getActivities).toHaveBeenCalledWith("session-1", undefined);
    expect(JulesClient.prototype.getActivities).toHaveBeenCalledWith("session-1", "page-2");

    const secondAbort = new AbortController();
    setTimeout(() => secondAbort.abort(), 10);
    await execute({
      ...base,
      runId: "run-2",
      runtime: { sessionParams: first.sessionParams },
      abortSignal: secondAbort.signal,
    });
    expect(postedBodies).toHaveLength(2);
  });
});
