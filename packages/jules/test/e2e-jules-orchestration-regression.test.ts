import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/execute";
import { JulesClient } from "../src/server/jules-client";
import { sessionCodec } from "../src/server/session";
import {
  addJulesActivityComment,
  answerJulesAgentAdjudicationInteraction,
  completeInternalReviewIssue,
  createJulesAgentAdjudicationInteraction,
  createJulesQuestionAdjudication,
  createNoPrCompletionInteraction,
  getPaperclipIssue,
  listIssueComments,
  listPaperclipInteractions,
  moveIssueToBlocked,
  scheduleJulesSessionMonitor,
  withdrawPaperclipInteraction,
} from "../src/server/paperclip-client";

/**
 * Regression E2E for the Jules/Paperclip continuation protocol.
 *
 * This deliberately drives the real execute() boundary through the same
 * heartbeat inputs Paperclip supplies.  The provider may report COMPLETED in
 * the same poll that exposes its final question; provider activity must be
 * reconciled before terminal completion handling.  This is the MAZ-834
 * failure mode: completion confirmation won the race and the Jules question
 * disappeared from the Paperclip reviewer ladder.
 */

vi.mock("../src/server/jules-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/jules-client")>();
  const MockedJulesClient = vi.fn();
  MockedJulesClient.prototype.getSession = vi.fn();
  MockedJulesClient.prototype.getActivities = vi.fn();
  MockedJulesClient.prototype.sendMessage = vi.fn();
  return { ...mod, JulesClient: MockedJulesClient };
});

vi.mock("../src/server/paperclip-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/paperclip-client")>();
  return {
    ...mod,
    addJulesActivityComment: vi.fn(),
    answerJulesAgentAdjudicationInteraction: vi.fn(),
    completeInternalReviewIssue: vi.fn(),
    createJulesAgentAdjudicationInteraction: vi.fn(),
    createJulesQuestionAdjudication: vi.fn(),
    createNoPrCompletionInteraction: vi.fn(),
    getPaperclipIssue: vi.fn(),
    listIssueComments: vi.fn(),
    listPaperclipInteractions: vi.fn(),
    moveIssueToBlocked: vi.fn(),
    scheduleJulesSessionMonitor: vi.fn(),
    withdrawPaperclipInteraction: vi.fn(),
  };
});

const baseSession = {
  version: 1 as const,
  paperclipIssueId: "MAZ-834",
  promptHash: "stable-prompt",
  promptHashVersion: 2,
  repository: "example/repository",
  source: "sources/github/example/repository",
  baseBranch: "main",
  phase: "RUNNING" as const,
  sessionId: "jules-834",
  julesSessionId: "jules-834",
  julesSessionUrl: "https://jules.google.com/session/jules-834",
  attempt: 1,
  failedSessions: [],
  createdAt: "2026-08-31T09:00:00.000Z",
};

const baseContext = {
  agent: {
    id: "jules-agent",
    companyId: "company-1",
    name: "Jules",
    adapterType: "jules",
    adapterConfig: {
      source: "sources/github/example/repository",
      repository: "example/repository",
      baseBranch: "main",
      questionReviewerAgentId: "00000000-0000-4000-8000-000000000834",
      pollIntervalSeconds: 60,
      heartbeatPollWindowSeconds: 30,
    },
  },
  runtime: {
    sessionId: "jules-834",
    sessionParams: sessionCodec.encode(baseSession),
    sessionDisplayId: "jules-834",
    taskKey: "MAZ-834",
  },
  config: { env: { JULES_API_KEY: "test-key" } },
  context: {
    task: {
      id: "MAZ-834",
      title: "Validate target module",
      description: "Fix the target module validation and add tests.",
    },
  },
  runId: "run-834",
  authToken: "paperclip-token",
  onLog: vi.fn(),
} as unknown as AdapterExecutionContext;

describe("E2E Jules orchestration regression", { timeout: 30_000 }, () => {
  beforeAll(() => {
    process.env.JULES_API_KEY = "test-key";
  });

  afterAll(() => {
    delete process.env.JULES_API_KEY;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(addJulesActivityComment).mockResolvedValue();
    vi.mocked(listPaperclipInteractions).mockResolvedValue([]);
    vi.mocked(scheduleJulesSessionMonitor).mockResolvedValue();
    vi.mocked(moveIssueToBlocked).mockResolvedValue();
    vi.mocked(withdrawPaperclipInteraction).mockResolvedValue();
    vi.mocked(answerJulesAgentAdjudicationInteraction).mockResolvedValue();
    vi.mocked(completeInternalReviewIssue).mockResolvedValue();
    vi.mocked(getPaperclipIssue).mockResolvedValue(null);
    vi.mocked(listIssueComments).mockResolvedValue([]);
    vi.mocked(createJulesQuestionAdjudication).mockResolvedValue({ id: "question-review-1", status: "todo" });
    vi.mocked(createJulesAgentAdjudicationInteraction).mockResolvedValue({ id: "visible-question-1", status: "pending" });
    vi.mocked(createNoPrCompletionInteraction).mockResolvedValue({ id: "completion-1", status: "pending" });
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "jules-834",
      name: "sessions/jules-834",
      state: "COMPLETED",
      url: "https://jules.google.com/session/jules-834",
    } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockImplementation(async (_sessionId, pageToken) => {
      if (!pageToken) {
        return {
          activities: [{
            id: "activity-progress",
            createTime: "2026-08-31T09:40:00.000Z",
            description: "Implemented the target module validation fix.",
          }],
          nextPageToken: "page-2",
        } as never;
      }
      return {
        activities: [
          { id: "activity-completed", createTime: "2026-08-31T09:42:00.000Z", sessionCompleted: {} },
          {
            id: "activity-question",
            createTime: "2026-08-31T09:42:20.252Z",
            agentMessaged: {
              agentMessage: "Could you clarify if there is an actual bug, or should I just ensure the fix is pushed and approved?",
            },
          },
        ],
      } as never;
    });
  });

  it("drains paginated provider work and routes a terminal Jules question before completion", async () => {
    const result = await execute(baseContext);

    // Both pages must be mirrored, including the question that arrived with
    // the terminal provider state.
    expect(addJulesActivityComment).toHaveBeenCalledTimes(2);
    expect(addJulesActivityComment).toHaveBeenCalledWith(
      "MAZ-834",
      "activity-question",
      expect.stringContaining("Could you clarify"),
      "https://jules.google.com/session/jules-834",
      "paperclip-token",
      "run-834",
    );

    // The question belongs to the strong-agent lane.  Completion without a
    // PR is not actionable until all provider questions are resolved.
    expect(createNoPrCompletionInteraction).not.toHaveBeenCalled();
    expect(moveIssueToBlocked).not.toHaveBeenCalled();
    expect(JulesClient.prototype.sendMessage).not.toHaveBeenCalled();
    expect(createJulesQuestionAdjudication).toHaveBeenCalledWith(
      "MAZ-834",
      "00000000-0000-4000-8000-000000000834",
      expect.stringContaining("Could you clarify"),
      "paperclip-token",
      "run-834",
      "company-1",
    );
    expect(result.resultJson).toMatchObject({ pending: true });
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "agent_adjudication",
      julesActivityId: "activity-question",
      adjudicationIssueId: "question-review-1",
    });
  });

  it("backfills a resolved visible question from the exact delivered activity while plan review is pending", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "jules-834", name: "sessions/jules-834", state: "IN_PROGRESS",
      url: "https://jules.google.com/session/jules-834",
    } as never);
    vi.mocked(listIssueComments).mockResolvedValue([{
      authorAgentId: "00000000-0000-4000-8000-000000000834",
      body: '{"kind":"ANSWER","answer":"Run the declared tests, then push the scoped fix."}',
    }] as never);

    const result = await execute({
      ...baseContext,
      runtime: {
        ...baseContext.runtime,
        sessionParams: sessionCodec.encode({
          ...baseSession,
          deliveredFeedbackActivityId: "activity-question",
          pendingInteraction: {
            type: "plan_agent_review", julesActivityId: "activity-plan", question: "Plan",
            planDocumentId: "doc-1", planRevisionId: "revision-1", planRevisionNumber: 1,
            reviewIssueId: "plan-review-1", reviewerAgentId: "reviewer-1", stage: "vibe",
            createdAt: "2026-08-31T09:40:00.000Z",
          },
        }),
      },
    } as AdapterExecutionContext);

    expect(createJulesAgentAdjudicationInteraction).toHaveBeenCalledWith(
      "MAZ-834", "jules-834", "activity-question",
      expect.stringContaining("Could you clarify"),
      "00000000-0000-4000-8000-000000000834", "paperclip-token", "run-834",
    );
    expect(answerJulesAgentAdjudicationInteraction).toHaveBeenCalledWith(
      "MAZ-834", "visible-question-1", "Run the declared tests, then push the scoped fix.",
      "paperclip-token", "run-834",
    );
    expect(JulesClient.prototype.sendMessage).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.deliveredFeedbackInteractionId).toBe("visible-question-1");
  });

  it("withdraws a stale no-PR confirmation when a later heartbeat reveals a question", async () => {
    const result = await execute({
      ...baseContext,
      runtime: {
        ...baseContext.runtime,
        sessionParams: sessionCodec.encode({
          ...baseSession,
          pendingInteraction: {
            type: "completion_confirmation",
            paperclipInteractionId: "stale-completion-1",
            question: "Jules completed without a PR. Is this task complete?",
            createdAt: "2026-08-31T09:41:00.000Z",
          },
        }),
      },
      context: {
        ...baseContext.context,
        interactionId: "stale-completion-1",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      },
    } as AdapterExecutionContext);

    expect(withdrawPaperclipInteraction).toHaveBeenCalledWith(
      "MAZ-834",
      "stale-completion-1",
      "Superseded by an unresolved Jules provider question",
      "paperclip-token",
      "run-834",
    );
    expect(createNoPrCompletionInteraction).not.toHaveBeenCalled();
    expect(createJulesQuestionAdjudication).toHaveBeenCalledTimes(1);
    expect(result.resultJson).toMatchObject({ pending: true });
  });

  it("reconciles an orphaned no-PR interaction after adapter session recovery", async () => {
    vi.mocked(listPaperclipInteractions).mockResolvedValueOnce([{
      id: "orphan-completion-1",
      kind: "request_confirmation",
      status: "pending",
      idempotencyKey: "jules:no-pr-completion:MAZ-834:jules-834",
    }]);

    const result = await execute(baseContext);

    expect(withdrawPaperclipInteraction).toHaveBeenCalledWith(
      "MAZ-834",
      "orphan-completion-1",
      "Superseded by an unresolved Jules provider question",
      "paperclip-token",
      "run-834",
    );
    expect(createNoPrCompletionInteraction).not.toHaveBeenCalled();
    expect(createJulesQuestionAdjudication).toHaveBeenCalledTimes(1);
    expect(result.resultJson).toMatchObject({ pending: true });
  });
});
