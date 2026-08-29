import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/execute";
import { JulesClient } from "../src/server/jules-client";
import { sessionCodec } from "../src/server/session";
import {
  addJulesActivityComment,
  createJulesFeedbackInteraction,
  createJulesPlanApprovalInteraction,
  getPaperclipInteraction,
  moveIssueToBlocked,
} from "../src/server/paperclip-client";

vi.mock("../src/server/jules-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/jules-client")>();
  const MockedJulesClient = vi.fn();
  MockedJulesClient.prototype.getSession = vi.fn();
  MockedJulesClient.prototype.getActivities = vi.fn();
  MockedJulesClient.prototype.sendMessage = vi.fn();
  MockedJulesClient.prototype.approvePlan = vi.fn();
  return { ...mod, JulesClient: MockedJulesClient };
});

vi.mock("../src/server/paperclip-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/paperclip-client")>();
  return {
    ...mod,
    addJulesActivityComment: vi.fn(),
    createJulesFeedbackInteraction: vi.fn(),
    createJulesPlanApprovalInteraction: vi.fn(),
    getPaperclipInteraction: vi.fn(),
    moveIssueToBlocked: vi.fn(),
  };
});

const session = {
  version: 1 as const,
  paperclipIssueId: "issue-1",
  promptHash: "stable-hash",
  promptHashVersion: 2,
  repository: "example/repository",
  source: "sources/github/example/repository",
  baseBranch: "main",
  phase: "RUNNING" as const,
  sessionId: "session-1",
  julesSessionId: "session-1",
  julesSessionUrl: "https://jules.example/session-1",
  attempt: 1,
  failedSessions: [],
  createdAt: "2026-08-08T00:00:00.000Z",
};

const baseContext = {
  agent: {
    id: "agent-1", companyId: "company-1", name: "Jules", adapterType: "jules",
    adapterConfig: {
      source: "sources/github/example/repository",
      repository: "example/repository",
      baseBranch: "main",
    },
  },
  runtime: { sessionId: "session-1", sessionParams: sessionCodec.encode(session), taskKey: "issue-1" },
  config: { env: { JULES_API_KEY: 'test-key' } },
  context: { task: { id: "issue-1", title: "Ping", description: "Do not change files" } },
  runId: "run-1",
  authToken: "jwt-token",
  onLog: vi.fn(),
} as AdapterExecutionContext;

describe("Jules activity interactions", () => {
  beforeAll(() => { process.env.JULES_API_KEY = "test-key"; });
  afterAll(() => { delete process.env.JULES_API_KEY; });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(addJulesActivityComment).mockResolvedValue();
    vi.mocked(moveIssueToBlocked).mockResolvedValue();
  });

  it("mirrors a Jules question and creates one Paperclip reply card", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_USER_FEEDBACK" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({
      activities: [{
        id: "activity-question",
        createTime: "2026-08-08T00:00:00.000Z",
        agentMessaged: { agentMessage: "Which branch should I use?" },
      }],
    } as never);
    vi.mocked(createJulesFeedbackInteraction).mockResolvedValue({ id: "feedback-1", status: "pending" });

    const result = await execute(baseContext);

    // Question is rendered inside the interactive card rather than duplicated as an orphaned comment
    expect(createJulesFeedbackInteraction).toHaveBeenCalledWith(
      "issue-1", "session-1", "activity-question", "Which branch should I use?", "jwt-token", 1, "run-1",
    );
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "user_feedback", paperclipInteractionId: "feedback-1", julesActivityId: "activity-question",
    });
  });

  it("sends the Paperclip free-text answer to Jules", async () => {
    vi.mocked(getPaperclipInteraction).mockResolvedValue({
      id: "feedback-1",
      status: "answered",
      result: { answers: [{ otherText: "Use the release branch." }] },
    });
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_USER_FEEDBACK" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] } as never);
    vi.mocked(createJulesFeedbackInteraction).mockResolvedValue({ id: "feedback-2", status: "pending" });

    const result = await execute({
      ...baseContext,
      runtime: {
        ...baseContext.runtime,
        sessionParams: sessionCodec.encode({
          ...session,
          phase: "WAITING_FOR_FEEDBACK",
          pendingInteraction: {
            type: "user_feedback",
            julesActivityId: "activity-question",
            paperclipInteractionId: "feedback-1",
            question: "Which branch?",
            createdAt: "2026-08-08T00:00:00.000Z",
          },
        }),
      },
      context: {
        ...baseContext.context,
        interactionId: "feedback-1",
        paperclipWake: {
          interactionKind: "ask_user_questions",
          interactionStatus: "answered",
        },
      },
    } as AdapterExecutionContext);

    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith("session-1", { prompt: "Use the release branch." });
    expect(JulesClient.prototype.getSession).not.toHaveBeenCalled();
    expect(createJulesFeedbackInteraction).not.toHaveBeenCalled();
    // pending checkpoint has exitCode 0
  });

  it("reopens the reply card instead of sending an empty answer to Jules", async () => {
    vi.mocked(getPaperclipInteraction).mockResolvedValue({
      id: "feedback-1",
      status: "answered",
      result: { answers: [{ optionIds: ["other"] }] },
    });
    vi.mocked(createJulesFeedbackInteraction).mockResolvedValue({ id: "feedback-2", status: "pending" });

    const result = await execute({
      ...baseContext,
      runtime: {
        ...baseContext.runtime,
        sessionParams: sessionCodec.encode({
          ...session,
          phase: "WAITING_FOR_FEEDBACK",
          feedbackInteractionAttempt: 1,
          pendingInteraction: {
            type: "user_feedback",
            julesActivityId: "activity-question",
            paperclipInteractionId: "feedback-1",
            question: "Which branch?",
            createdAt: "2026-08-08T00:00:00.000Z",
          },
        }),
      },
      context: {
        ...baseContext.context,
        interactionId: "feedback-1",
        paperclipWake: { interactionKind: "ask_user_questions", interactionStatus: "answered" },
      },
    } as AdapterExecutionContext);

    expect(JulesClient.prototype.sendMessage).not.toHaveBeenCalled();
    expect(createJulesFeedbackInteraction).toHaveBeenCalledWith(
      "issue-1", "session-1", "activity-question", "Which branch?", "jwt-token", 2, "run-1",
    );
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      paperclipInteractionId: "feedback-2",
    });
  });

  it("approves a Jules plan only after Paperclip accepts it", async () => {
    vi.mocked(getPaperclipInteraction).mockResolvedValue({
      id: "plan-1", kind: "request_confirmation", status: "accepted",
      target: { type: "issue_document", key: "plan", revisionId: "revision-1" },
    });
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] } as never);
    vi.mocked(createJulesPlanApprovalInteraction).mockResolvedValue({ id: "plan-2", status: "pending" });

    await execute({
      ...baseContext,
      runtime: {
        ...baseContext.runtime,
        sessionParams: sessionCodec.encode({
          ...session,
          phase: "WAITING_FOR_PLAN_APPROVAL",
          pendingInteraction: {
            type: "plan_approval",
            julesActivityId: "activity-plan",
            paperclipInteractionId: "plan-1",
            question: "**Jules plan**",
            planDocumentId: "doc-1",
            planRevisionId: "revision-1",
            planRevisionNumber: 1,
            createdAt: "2026-08-08T00:00:00.000Z",
          },
        }),
      },
      context: {
        ...baseContext.context,
        interactionId: "plan-1",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      },
    } as AdapterExecutionContext);

    expect(JulesClient.prototype.approvePlan).toHaveBeenCalledWith("session-1");
  });

  it("sends a plan rejection reason to Jules so it can regenerate the plan", async () => {
    vi.mocked(getPaperclipInteraction).mockResolvedValue({
      id: "plan-1",
      kind: "request_confirmation",
      status: "rejected",
      result: { rejectReason: "Include rollback steps." },
      target: { type: "issue_document", key: "plan", revisionId: "revision-1" },
    });

    const result = await execute({
      ...baseContext,
      runtime: {
        ...baseContext.runtime,
        sessionParams: sessionCodec.encode({
          ...session,
          phase: "WAITING_FOR_PLAN_APPROVAL",
          pendingInteraction: {
            type: "plan_approval",
            julesActivityId: "activity-plan",
            paperclipInteractionId: "plan-1",
            question: "**Jules plan**",
            planDocumentId: "doc-1",
            planRevisionId: "revision-1",
            planRevisionNumber: 1,
            createdAt: "2026-08-08T00:00:00.000Z",
          },
        }),
      },
      context: {
        ...baseContext.context,
        interactionId: "plan-1",
        interactionKind: "request_confirmation",
        interactionStatus: "rejected",
      },
    } as AdapterExecutionContext);

    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith(
      "session-1",
      { prompt: expect.stringContaining("Include rollback steps.") },
    );
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toBeUndefined();
    expect(result.summary).toContain("regenerate");
  });
});
