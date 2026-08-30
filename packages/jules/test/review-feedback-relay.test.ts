import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/execute.js";
import { JulesClient } from "../src/server/jules-client.js";
import { sessionCodec } from "../src/server/session.js";
import { listIssueComments } from "../src/server/paperclip-client.js";

vi.mock("../src/server/ci-status.js", () => ({
  getPullRequestDetails: vi.fn().mockResolvedValue({ merged: false, ciStatus: "success", state: "OPEN" }),
  getPullRequestCiStatus: vi.fn().mockResolvedValue("success"),
  listPullRequestChangedFiles: vi.fn().mockResolvedValue([]),
  getPullRequestPatch: vi.fn().mockResolvedValue(""),
}));

vi.mock("../src/server/jules-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/jules-client.js")>();
  const MockedJulesClient = vi.fn();
  MockedJulesClient.prototype.getSession = vi.fn();
  MockedJulesClient.prototype.getActivities = vi.fn();
  MockedJulesClient.prototype.sendMessage = vi.fn();
  MockedJulesClient.prototype.approvePlan = vi.fn();
  return { ...mod, JulesClient: MockedJulesClient };
});

vi.mock("../src/server/paperclip-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/paperclip-client.js")>();
  return {
    ...mod,
    createJulesPlanApprovalInteraction: vi.fn(),
    createIssueComment: vi.fn().mockResolvedValue(undefined),
    createNoPrCompletionInteraction: vi.fn().mockResolvedValue({ id: "inter-comp-1" }),
    listIssueComments: vi.fn().mockResolvedValue([]),
    getPaperclipInteraction: vi.fn(),
    moveIssueToBlocked: vi.fn(),
    moveIssueToInProgress: vi.fn(),
    moveIssueToReview: vi.fn(),
    listPaperclipInteractions: vi.fn().mockResolvedValue([]),
  };
});

describe("Review Feedback Relay to Jules", () => {
  const session = {
    version: 1 as const,
    paperclipIssueId: "issue-141",
    promptHash: "hash-141",
    promptHashVersion: 2,
    repository: "Pilleo/mazewall",
    source: "sources/github/Pilleo/mazewall",
    baseBranch: "master",
    phase: "RUNNING" as const,
    sessionId: "session-141",
    julesSessionId: "session-141",
    julesSessionUrl: "https://jules.example/session-141",
    attempt: 1,
    failedSessions: [],
    relayedReviewCommentIds: [],
    createdAt: "2026-08-30T00:00:00.000Z",
  };

  const adapterConfig = {
    env: { JULES_API_KEY: "test-key" },
    repository: "Pilleo/mazewall",
    baseBranch: "master",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("relays new code review feedback comments directly to active Jules session via sendMessage", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-141",
      state: "COMPLETED",
      url: "https://jules.example/session-141",
    });
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({
      activities: [
        {
          id: "act-1",
          createTime: new Date().toISOString(),
          pullRequestCreated: {
            pullRequest: { url: "https://github.com/Pilleo/mazewall/pull/400" },
          },
        },
      ],
    });
    vi.mocked(JulesClient.prototype.sendMessage).mockResolvedValue(null);

    vi.mocked(listIssueComments).mockResolvedValue([
      {
        id: "comment-review-1",
        body: "## 🛑 Automated Code Review Verdict: **REQUEST_CHANGES**\n- Violation: Unbounded cache growth detected.",
        authorAgentId: "reviewer-agent-id",
        createdAt: new Date().toISOString(),
      },
    ]);

    const ctx = {
      agent: {
        id: "jules-1",
        companyId: "c-1",
        name: "Jules",
        adapterType: "jules",
        adapterConfig,
      },
      runtime: { sessionParams: sessionCodec.encode(session) },
      context: { task: { id: "issue-141", title: "Cap SandboxDispatcher poolCache growth" } },
      config: adapterConfig,
      authToken: "mock-token",
      onLog: vi.fn().mockResolvedValue(undefined),
    } as unknown as AdapterExecutionContext;

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith(
      "session-141",
      expect.objectContaining({
        prompt: expect.stringContaining("REQUEST_CHANGES"),
      })
    );
  });
});
