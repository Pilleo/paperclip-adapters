import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/execute";
import { JulesClient } from "../src/server/jules-client";
import { sessionCodec } from "../src/server/session";
import {
  addJulesActivityComment,
  createJulesAgentAdjudicationInteraction,
  createJulesQuestionReviewInteraction,
  answerJulesAgentAdjudicationInteraction,
  resolveJulesAgentAdjudicationInteraction,
  activateInternalReviewIssue,
  createJulesFeedbackInteraction,
  createJulesHumanEscalationInteraction,
  createJulesQuestionAdjudication,
  createJulesPlanApprovalInteraction,
  createJulesPlanReviewInteraction,
  createJulesPlanReviewChildInteraction,
  clearJulesSessionMonitor,
  getPaperclipInteraction,
  findJulesQuestionAdjudication,
  getPaperclipIssue,
  completeInternalReviewIssue,
  listIssueComments,
  listPaperclipInteractions,
  moveIssueToBlocked,
  moveIssueToInProgress,
  withdrawPaperclipInteraction,
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

vi.mock("../src/server/ci-status", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/ci-status")>();
  return {
    ...mod,
    getPullRequestDetails: vi.fn().mockResolvedValue({
      merged: false,
      ciStatus: "pending",
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      mergeableStatus: "mergeable",
    }),
    listPullRequestChangedFiles: vi.fn().mockResolvedValue([]),
    getPullRequestPatch: vi.fn().mockResolvedValue(""),
  };
});

vi.mock("../src/server/paperclip-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/paperclip-client")>();
  return {
    ...mod,
    addJulesActivityComment: vi.fn(),
    createJulesAgentAdjudicationInteraction: vi.fn(),
    createJulesQuestionReviewInteraction: vi.fn(),
    answerJulesAgentAdjudicationInteraction: vi.fn().mockResolvedValue(undefined),
    resolveJulesAgentAdjudicationInteraction: vi.fn().mockResolvedValue(undefined),
    activateInternalReviewIssue: vi.fn().mockResolvedValue(undefined),
    createJulesFeedbackInteraction: vi.fn(),
    createJulesHumanEscalationInteraction: vi.fn(),
    createJulesQuestionAdjudication: vi.fn(),
    createJulesPlanApprovalInteraction: vi.fn(),
    createJulesPlanReviewInteraction: vi.fn(),
    createJulesPlanReviewChildInteraction: vi.fn(),
    clearJulesSessionMonitor: vi.fn(),
    getPaperclipInteraction: vi.fn(),
    listPaperclipInteractions: vi.fn().mockResolvedValue([]),
    listIssueComments: vi.fn().mockResolvedValue([]),
    findJulesQuestionAdjudication: vi.fn(),
    getPaperclipIssue: vi.fn(),
    normalizeInternalReviewIssue: vi.fn().mockResolvedValue(undefined),
    completeInternalReviewIssue: vi.fn().mockResolvedValue(undefined),
    moveIssueToBlocked: vi.fn(),
    moveIssueToInProgress: vi.fn().mockResolvedValue(undefined),
    withdrawPaperclipInteraction: vi.fn().mockResolvedValue(undefined),
    scheduleJulesSessionMonitor: vi.fn().mockResolvedValue(),
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
      questionReviewerAgentId: "00000000-0000-4000-8000-000000000123",
    },
  },
  runtime: { sessionId: "session-1", sessionParams: sessionCodec.encode(session), taskKey: "issue-1" },
  config: { env: { JULES_API_KEY: 'test-key' } },
  context: { task: { id: "issue-1", title: "Ping", description: "Do not change files" } },
  runId: "run-1",
  authToken: "jwt-token",
  onLog: vi.fn(),
} as AdapterExecutionContext;

describe("Jules activity interactions", { timeout: 30000 }, () => {
  beforeAll(() => { process.env.JULES_API_KEY = "test-key"; });
  afterAll(() => { delete process.env.JULES_API_KEY; });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(addJulesActivityComment).mockResolvedValue();
    vi.mocked(moveIssueToBlocked).mockResolvedValue();
    vi.mocked(createJulesQuestionAdjudication).mockResolvedValue({ id: "child-question-1", status: "todo" } as never);
    vi.mocked(createJulesQuestionReviewInteraction).mockResolvedValue({ id: "child-form-1", status: "pending" });
    vi.mocked(createJulesPlanReviewInteraction).mockResolvedValue({
      id: "plan-review-1", status: "pending", kind: "request_item_verdicts",
      planRevision: { documentId: "plan-doc-1", revisionId: "plan-revision-1", revisionNumber: 1 },
    } as never);
    vi.mocked(createJulesPlanReviewChildInteraction).mockResolvedValue({
      id: "plan-review-child-form-1", status: "pending", kind: "request_item_verdicts",
      planRevision: { documentId: "plan-doc-1", revisionId: "plan-revision-1", revisionNumber: 1 },
    } as never);
    vi.mocked(clearJulesSessionMonitor).mockResolvedValue(undefined);
    vi.mocked(createJulesPlanApprovalInteraction).mockResolvedValue({
      id: "plan-approval-1", status: "pending", kind: "request_confirmation",
      planRevision: { documentId: "plan-doc-1", revisionId: "plan-revision-1", revisionNumber: 1 },
    } as never);
    vi.mocked(getPaperclipInteraction).mockResolvedValue(null);
    vi.mocked(getPaperclipIssue).mockResolvedValue(null);
  });

  it("mirrors a Jules question into a visible parent card and Terra child form", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_USER_FEEDBACK" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({
      activities: [{
        id: "activity-question",
        createTime: "2026-08-08T00:00:00.000Z",
        agentMessaged: { agentMessage: "Which branch should I use?" },
      }],
    } as never);
    vi.mocked(createJulesAgentAdjudicationInteraction).mockResolvedValue({ id: "visible-question-1", status: "pending" });

    const result = await execute(baseContext);

    expect(createJulesQuestionAdjudication).toHaveBeenCalled();
    expect(createJulesQuestionReviewInteraction).toHaveBeenCalledWith(
      "child-question-1", "issue-1", "session-1", "activity-question", "Which branch should I use?",
      "00000000-0000-4000-8000-000000000123", "jwt-token", "run-1",
    );
    expect(createJulesAgentAdjudicationInteraction).toHaveBeenCalledWith(
      "issue-1", "session-1", "activity-question", "Which branch should I use?",
      "00000000-0000-4000-8000-000000000123", "jwt-token", "run-1",
    );
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "agent_adjudication", nativeForm: true, transport: "child_form_bridge", paperclipInteractionId: "visible-question-1", reviewerChildIssueId: "child-question-1", reviewerInteractionId: "child-form-1", julesActivityId: "activity-question",
    });
    expect(sessionCodec.decode(result.sessionParams!)?.unresolvedProviderQuestionActivityId).toBe("activity-question");
  });

  it("mirrors a later operational question instead of suppressing it behind an old revised plan", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_USER_FEEDBACK" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({
      activities: [
        {
          id: "plan-original",
          createTime: "2026-09-08T20:00:00.000Z",
          planGenerated: { plan: { steps: [{ index: 0, title: "Original", description: "Initial plan." }] } },
        },
        {
          id: "plan-revised",
          createTime: "2026-09-08T20:01:00.000Z",
          planGenerated: { plan: { steps: [{ index: 0, title: "Revised", description: "Revised plan." }] } },
        },
        {
          id: "prior-completion",
          createTime: "2026-09-08T20:01:30.000Z",
          sessionCompleted: {},
        },
        {
          id: "later-operational-question",
          createTime: "2026-09-08T20:02:00.000Z",
          agentMessaged: { agentMessage: "The branch is green. Would you like me to finalize now?" },
        },
      ],
    } as never);
    vi.mocked(createJulesAgentAdjudicationInteraction).mockResolvedValue({ id: "visible-question-later", status: "pending" });

    const result = await execute({
      ...baseContext,
      runtime: {
        ...baseContext.runtime,
        sessionParams: sessionCodec.encode({
          ...session,
          phase: "WAITING_FOR_FEEDBACK",
          planReviewOutcome: "revision_requested",
          deliveredFeedbackActivityId: "old-feedback",
        }),
      },
    } as AdapterExecutionContext);

    expect(createJulesAgentAdjudicationInteraction).toHaveBeenCalledWith(
      "issue-1", "session-1", "later-operational-question",
      "The branch is green. Would you like me to finalize now?",
      "00000000-0000-4000-8000-000000000123", "jwt-token", "run-1",
    );
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "agent_adjudication", julesActivityId: "later-operational-question",
    });
  });

  it("does not fabricate a question card from a coarse awaiting-feedback state", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_USER_FEEDBACK" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] } as never);

    const result = await execute(baseContext);

    expect(createJulesAgentAdjudicationInteraction).not.toHaveBeenCalled();
    expect(createJulesQuestionAdjudication).not.toHaveBeenCalled();
    expect(createJulesQuestionReviewInteraction).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toBeUndefined();
  });

  it("replaces a generic legacy human card with the recovered concrete provider question", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_USER_FEEDBACK" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({
      activities: [{
        id: "activity-recovered",
        createTime: "2026-09-08T19:23:44.459575Z",
        agentMessaged: { agentMessage: "The CI fix is ready. What should I do next?" },
      }],
    } as never);
    vi.mocked(getPaperclipInteraction).mockResolvedValue({ id: "legacy-human-card", status: "pending" } as never);
    vi.mocked(createJulesAgentAdjudicationInteraction).mockResolvedValue({ id: "visible-question-2", status: "pending" });

    const result = await execute({
      ...baseContext,
      runtime: {
        ...baseContext.runtime,
        sessionParams: sessionCodec.encode({
          ...session,
          phase: "WAITING_FOR_FEEDBACK",
          deliveredFeedbackActivityId: "old-activity",
          pendingInteraction: {
            type: "user_feedback",
            julesActivityId: "activity-recovered",
            paperclipInteractionId: "legacy-human-card",
            question: "Jules is awaiting user feedback.",
            createdAt: "2026-09-08T19:36:26.593Z",
          },
        }),
      },
    } as AdapterExecutionContext);

    expect(withdrawPaperclipInteraction).toHaveBeenCalledWith(
      "issue-1",
      "legacy-human-card",
      expect.stringContaining("Superseded"),
      "jwt-token",
      "run-1",
    );
    expect(createJulesAgentAdjudicationInteraction).toHaveBeenCalledWith(
      "issue-1", "session-1", "activity-recovered", "The CI fix is ready. What should I do next?",
      "00000000-0000-4000-8000-000000000123", "jwt-token", "run-1",
    );
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "agent_adjudication", question: "The CI fix is ready. What should I do next?",
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

  it("consumes the Terra child form, resolves the parent card, and relays once", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_USER_FEEDBACK" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] } as never);
    vi.mocked(getPaperclipInteraction).mockResolvedValue({
      id: "child-form-1", status: "answered", result: { answers: [
        { questionId: "resolution", optionIds: ["answer"] },
        { questionId: "response", otherText: "Run the declared tests and submit the PR." },
      ] },
    });
    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_FEEDBACK",
        pendingInteraction: {
          type: "agent_adjudication", nativeForm: true, transport: "child_form_bridge",
          julesActivityId: "activity-question", paperclipInteractionId: "parent-form-1",
          reviewerChildIssueId: "child-1", reviewerInteractionId: "child-form-1",
          question: "Should I submit?", reviewerAgentId: "terra-1", createdAt: "2026-08-08T00:00:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(resolveJulesAgentAdjudicationInteraction).toHaveBeenCalledWith(
      "issue-1", "parent-form-1", "answer", "Run the declared tests and submit the PR.", "jwt-token", "run-1",
    );
    expect(completeInternalReviewIssue).toHaveBeenCalledWith("child-1", "jwt-token", "run-1");
    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledTimes(1);
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction?.type).not.toBe("agent_adjudication");
  });

  it("does not relay a resolved stale child bridge after Jules asks a newer question", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_USER_FEEDBACK" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({
      activities: [
        {
          id: "activity-old-question",
          createTime: "2026-08-08T00:00:00.000Z",
          agentMessaged: { agentMessage: "Should I submit the old change?" },
        },
        {
          id: "activity-new-question",
          createTime: "2026-08-08T00:05:00.000Z",
          agentMessaged: { agentMessage: "Should I adjust the PATH mock or the test harness?" },
        },
      ],
    } as never);
    vi.mocked(getPaperclipInteraction).mockImplementation(async (_issueId, interactionId) => {
      if (interactionId === "child-form-1") {
        return {
          id: "child-form-1", status: "answered", result: { answers: [
            { questionId: "resolution", optionIds: ["answer"] },
            { questionId: "response", otherText: "Submit the old change." },
          ] },
        } as never;
      }
      return null;
    });
    vi.mocked(createJulesAgentAdjudicationInteraction).mockResolvedValue({ id: "visible-question-new", status: "pending" });

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_FEEDBACK",
        pendingInteraction: {
          type: "agent_adjudication", nativeForm: true, transport: "child_form_bridge",
          julesActivityId: "activity-old-question", paperclipInteractionId: "parent-form-old",
          reviewerChildIssueId: "child-1", reviewerInteractionId: "child-form-1",
          question: "Should I submit the old change?", reviewerAgentId: "terra-1", createdAt: "2026-08-08T00:00:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(JulesClient.prototype.sendMessage).not.toHaveBeenCalled();
    await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: result.sessionParams },
    } as AdapterExecutionContext);
    expect(createJulesAgentAdjudicationInteraction).toHaveBeenCalledWith(
      "issue-1", "session-1", "activity-new-question", "Should I adjust the PATH mock or the test harness?",
      "00000000-0000-4000-8000-000000000123", "jwt-token", "run-1",
    );
  });

  it("opens a human-only escalation form when the strong reviewer cannot answer", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_USER_FEEDBACK" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] } as never);
    vi.mocked(getPaperclipInteraction).mockResolvedValue({
      id: "child-form-1", status: "answered", result: { answers: [
        { questionId: "resolution", optionIds: ["escalate"] },
        { questionId: "response", otherText: "The repository does not identify the correct monitor API." },
      ] },
    });
    vi.mocked(createJulesHumanEscalationInteraction).mockResolvedValue({ id: "human-form-1", status: "pending" });

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        julesState: "COMPLETED",
        currentPrUrl: "https://github.com/example/repository/pull/1",
        phase: "WAITING_FOR_FEEDBACK",
        pendingInteraction: {
          type: "agent_adjudication", nativeForm: true, transport: "child_form_bridge",
          julesActivityId: "activity-question", paperclipInteractionId: "parent-form-1",
          reviewerChildIssueId: "child-1", reviewerInteractionId: "child-form-1",
          question: "Which monitor API should I use?", reviewerAgentId: "terra-1", createdAt: "2026-08-08T00:00:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(createJulesHumanEscalationInteraction).toHaveBeenCalledWith(
      "issue-1", "session-1", "activity-question", "Which monitor API should I use?",
      "The repository does not identify the correct monitor API.", "jwt-token", "run-1",
    );
    expect(createJulesFeedbackInteraction).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "user_feedback", paperclipInteractionId: "human-form-1", question: "Which monitor API should I use?",
    });
  });

  it("replaces a terminal child that completed before its typed form existed", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_USER_FEEDBACK" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] } as never);
    vi.mocked(getPaperclipIssue).mockResolvedValue({
      id: "old-child", status: "done", assigneeAgentId: "terra-1",
    } as never);
    vi.mocked(getPaperclipInteraction).mockResolvedValue(null);
    vi.mocked(createJulesQuestionAdjudication).mockResolvedValue({ id: "fresh-child", status: "blocked" } as never);
    vi.mocked(createJulesQuestionReviewInteraction).mockResolvedValue({ id: "fresh-form", status: "pending" });

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        // Mirror a checkpoint written after the provider had already exposed
        // its PR. A historical question activity must not win over this
        // terminal provider state during the next monitor heartbeat.
        julesState: "COMPLETED",
        currentPrUrl: "https://github.com/example/repository/pull/1",
        phase: "WAITING_FOR_FEEDBACK",
        pendingInteraction: {
          type: "agent_adjudication", nativeForm: true, transport: "child_form_bridge",
          julesActivityId: "activity-question", paperclipInteractionId: "parent-form-1",
          reviewerChildIssueId: "old-child", reviewerInteractionId: "old-form",
          question: "Should I proceed?", reviewerAgentId: "terra-1", adjudicationGeneration: 1,
          createdAt: "2026-08-08T00:00:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(createJulesQuestionAdjudication).toHaveBeenCalledWith(
      "issue-1", "terra-1", "Should I proceed?", "jwt-token", "run-1", "company-1",
      "activity-question", "session-1", 2, true,
    );
    expect(activateInternalReviewIssue).toHaveBeenCalledWith("fresh-child", "terra-1", "jwt-token", "run-1");
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      reviewerChildIssueId: "fresh-child", reviewerInteractionId: "fresh-form", adjudicationGeneration: 2,
    });
    expect(JulesClient.prototype.sendMessage).not.toHaveBeenCalled();
  });

  it("repairs one legacy expired bridge after the old generic recovery budget was exhausted", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_USER_FEEDBACK" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] } as never);
    vi.mocked(getPaperclipIssue).mockResolvedValue({
      id: "old-child", status: "done", assigneeAgentId: "terra-1",
    } as never);
    vi.mocked(getPaperclipInteraction).mockResolvedValue({
      id: "old-form", status: "expired", result: { outcome: "issue_closed" },
    } as never);
    vi.mocked(createJulesQuestionAdjudication).mockResolvedValue({ id: "repaired-child", status: "backlog" } as never);
    vi.mocked(createJulesQuestionReviewInteraction).mockResolvedValue({ id: "repaired-form", status: "pending" });

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_FEEDBACK",
        adjudicationRecoveryCount: 2,
        pendingInteraction: {
          type: "agent_adjudication", nativeForm: true, transport: "child_form_bridge",
          julesActivityId: "activity-question", paperclipInteractionId: "parent-form-1",
          reviewerChildIssueId: "old-child", reviewerInteractionId: "old-form",
          question: "Which resolver should I use?", reviewerAgentId: "terra-1", adjudicationGeneration: 2,
          createdAt: "2026-08-08T00:00:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(createJulesQuestionAdjudication).toHaveBeenCalledWith(
      "issue-1", "terra-1", "Which resolver should I use?", "jwt-token", "run-1", "company-1",
      "activity-question", "session-1", 3, true,
    );
    expect(sessionCodec.decode(result.sessionParams!)?.adjudicationBridgeRepairAttempt).toBe(1);
  });

  it("does not repeatedly requeue the same expired-bridge migration", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_USER_FEEDBACK" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] } as never);
    vi.mocked(getPaperclipIssue).mockResolvedValue({ id: "old-child", status: "done" } as never);
    vi.mocked(getPaperclipInteraction).mockResolvedValue({
      id: "old-form", status: "expired", result: { outcome: "issue_closed" },
    } as never);

    await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_FEEDBACK",
        adjudicationRecoveryCount: 2,
        adjudicationBridgeRepairAttempt: 1,
        pendingInteraction: {
          type: "agent_adjudication", nativeForm: true, transport: "child_form_bridge",
          julesActivityId: "activity-question", paperclipInteractionId: "parent-form-1",
          reviewerChildIssueId: "old-child", reviewerInteractionId: "old-form",
          question: "Which resolver should I use?", reviewerAgentId: "terra-1", adjudicationGeneration: 3,
          createdAt: "2026-08-08T00:00:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(createJulesQuestionAdjudication).not.toHaveBeenCalled();
  });

  it("replaces a missing child-form bridge instead of yielding forever", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_USER_FEEDBACK" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] } as never);
    vi.mocked(getPaperclipIssue).mockResolvedValue(null);
    vi.mocked(getPaperclipInteraction).mockResolvedValue(null);
    vi.mocked(createJulesQuestionAdjudication).mockResolvedValue({ id: "replacement-child", status: "blocked" } as never);
    vi.mocked(createJulesQuestionReviewInteraction).mockResolvedValue({ id: "replacement-form", status: "pending" });

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_FEEDBACK",
        pendingInteraction: {
          type: "agent_adjudication", nativeForm: true, transport: "child_form_bridge",
          julesActivityId: "activity-question", paperclipInteractionId: "parent-form-1",
          reviewerChildIssueId: "missing-child", reviewerInteractionId: "missing-form",
          question: "Which monitor API clears terminal state?", reviewerAgentId: "terra-1",
          createdAt: "2026-08-08T00:00:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(createJulesQuestionAdjudication).toHaveBeenCalledWith(
      "issue-1", "terra-1", "Which monitor API clears terminal state?", "jwt-token", "run-1", "company-1",
      "activity-question", "session-1", 1, true,
    );
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      reviewerChildIssueId: "replacement-child", reviewerInteractionId: "replacement-form", adjudicationGeneration: 1,
    });
  });

  it("recreates the missing parent card before replacing a terminal native child bridge", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_USER_FEEDBACK" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "activity-question", createTime: "2026-08-08T00:00:00.000Z",
      agentMessaged: { agentMessage: "Which literal package artifact should the test import?" },
    }] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([]);
    vi.mocked(getPaperclipIssue).mockResolvedValue({ id: "old-child", status: "done" } as never);
    vi.mocked(getPaperclipInteraction).mockResolvedValue(null);
    vi.mocked(createJulesAgentAdjudicationInteraction).mockResolvedValue({ id: "visible-question-repaired", status: "pending" });
    vi.mocked(createJulesQuestionAdjudication).mockResolvedValue({ id: "replacement-child", status: "blocked" } as never);
    vi.mocked(createJulesQuestionReviewInteraction).mockResolvedValue({ id: "replacement-form", status: "pending" });

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_FEEDBACK",
        adjudicationRecoveryCount: 2,
        pendingInteraction: {
          type: "agent_adjudication", nativeForm: true, transport: "child_form_bridge",
          julesActivityId: "activity-question", paperclipInteractionId: "missing-parent-form",
          reviewerChildIssueId: "old-child", reviewerInteractionId: "missing-child-form",
          question: "Which literal package artifact should the test import?", reviewerAgentId: "terra-1",
          createdAt: "2026-08-08T00:00:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(createJulesAgentAdjudicationInteraction).toHaveBeenCalledWith(
      "issue-1", "session-1", "activity-question", "Which literal package artifact should the test import?",
      "terra-1", "jwt-token", "run-1",
    );
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      paperclipInteractionId: "visible-question-repaired",
      reviewerChildIssueId: "replacement-child",
      reviewerInteractionId: "replacement-form",
    });
    expect(sessionCodec.decode(result.sessionParams!)?.missingParentBridgeRepairAttempt).toBe(1);
  });

  it("does not recreate a missing parent bridge after its one-time migration repair", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_USER_FEEDBACK" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "activity-question", createTime: "2026-08-08T00:00:00.000Z",
      agentMessaged: { agentMessage: "Which literal package artifact should the test import?" },
    }] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([]);
    vi.mocked(getPaperclipIssue).mockResolvedValue({ id: "old-child", status: "done" } as never);
    vi.mocked(getPaperclipInteraction).mockResolvedValue(null);

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_FEEDBACK",
        adjudicationRecoveryCount: 2,
        missingParentBridgeRepairAttempt: 1,
        pendingInteraction: {
          type: "agent_adjudication", nativeForm: true, transport: "child_form_bridge",
          julesActivityId: "activity-question", paperclipInteractionId: "missing-parent-form",
          reviewerChildIssueId: "old-child", reviewerInteractionId: "missing-child-form",
          question: "Which literal package artifact should the test import?", reviewerAgentId: "terra-1",
          createdAt: "2026-08-08T00:00:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(createJulesAgentAdjudicationInteraction).not.toHaveBeenCalled();
    expect(createJulesQuestionAdjudication).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      paperclipInteractionId: "missing-parent-form",
      reviewerChildIssueId: "old-child",
    });
  });

  it("supersedes a persisted question bridge when the provider completes with a PR", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      state: "COMPLETED",
    } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [
      { id: "activity-question", createTime: "2026-08-08T00:00:00.000Z", agentMessaged: { agentMessage: "Which monitor API clears terminal state?" } },
      { id: "activity-completed", createTime: "2026-08-08T00:01:00.000Z", sessionCompleted: {} },
    ] } as never);
    vi.mocked(getPaperclipIssue).mockResolvedValue(null);
    vi.mocked(getPaperclipInteraction).mockResolvedValue(null);
    vi.mocked(createJulesQuestionAdjudication).mockResolvedValue({ id: "replacement-child", status: "blocked" } as never);
    vi.mocked(createJulesQuestionReviewInteraction).mockResolvedValue({ id: "replacement-form", status: "pending" });

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_FEEDBACK",
        pendingInteraction: {
          type: "agent_adjudication", nativeForm: true, transport: "child_form_bridge",
          julesActivityId: "activity-question", paperclipInteractionId: "parent-form-1",
          reviewerChildIssueId: "missing-child", reviewerInteractionId: "missing-form",
          question: "Which monitor API clears terminal state?", reviewerAgentId: "terra-1",
          createdAt: "2026-08-08T00:00:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(createJulesQuestionAdjudication).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toBeUndefined();
  });

  it("recovers a lost native-form pointer and relays its structured answer once", async () => {
    vi.mocked(createJulesQuestionAdjudication).mockResolvedValue({ id: "child-question-1", status: "todo" } as never);
    vi.mocked(createJulesQuestionReviewInteraction).mockResolvedValue({ id: "child-form-1", status: "pending" });
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_USER_FEEDBACK" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({
      activities: [{
        id: "activity-question-recovered",
        createTime: "2026-08-08T00:00:00.000Z",
        agentMessaged: { agentMessage: "The recovery canary differs from the requested test. Should I rewrite it?" },
      }],
    } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "visible-question-recovered",
      kind: "ask_user_questions",
      status: "pending",
      idempotencyKey: "jules:agent-adjudication:issue-1:session-1:activity-question-recovered",
    }]);
    const first = await execute(baseContext);
    expect(sessionCodec.decode(first.sessionParams!)?.pendingInteraction).toMatchObject({
      transport: "child_form_bridge", reviewerChildIssueId: "child-question-1", reviewerInteractionId: "child-form-1",
    });
    vi.mocked(listPaperclipInteractions).mockResolvedValue([]);
    vi.mocked(getPaperclipInteraction).mockResolvedValue({
      id: "visible-question-recovered", status: "answered", result: { answers: [
        { questionId: "resolution", optionIds: ["answer"] },
        { questionId: "response", otherText: "Reapply the requested server-observed assertion, then run the declared tests." },
      ] },
    });
    const result = await execute({ ...baseContext, runtime: { ...baseContext.runtime, sessionParams: first.sessionParams } });

    expect(findJulesQuestionAdjudication).toHaveBeenCalledTimes(1);
    expect(findJulesQuestionAdjudication).toHaveBeenCalledWith(
      "issue-1", "company-1", "00000000-0000-4000-8000-000000000123",
      "session-1", "activity-question-recovered", "jwt-token", "run-1",
    );
    expect(listIssueComments).not.toHaveBeenCalled();
    expect(completeInternalReviewIssue).toHaveBeenCalledWith("child-question-1", "jwt-token", "run-1");
    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledTimes(1);
    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith("session-1", {
      prompt: "Reapply the requested server-observed assertion, then run the declared tests.",
    });
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction?.type).not.toBe("agent_adjudication");
  });

  it("consumes an already-answered child form while rebuilding a lost native-form pointer", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_USER_FEEDBACK" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({
      activities: [{
        id: "activity-recovered-answered-child",
        createTime: "2026-09-14T06:34:00.000Z",
        agentMessaged: { agentMessage: "Should I continue with the approved plan?" },
      }],
    } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "visible-question-recovered-answered-child",
      kind: "ask_user_questions",
      status: "pending",
      idempotencyKey: "jules:agent-adjudication:issue-1:session-1:activity-recovered-answered-child",
    }]);
    vi.mocked(createJulesQuestionReviewInteraction).mockResolvedValue({
      id: "child-form-recovered-answered", status: "answered", result: { answers: [
        { questionId: "resolution", optionIds: ["answer"] },
        { questionId: "response", otherText: "Continue the approved plan, run its declared tests, and update the PR." },
      ] },
    });

    const result = await execute(baseContext);

    expect(resolveJulesAgentAdjudicationInteraction).toHaveBeenCalledWith(
      "issue-1", "visible-question-recovered-answered-child", "answer",
      "Continue the approved plan, run its declared tests, and update the PR.", "jwt-token", "run-1",
    );
    expect(completeInternalReviewIssue).toHaveBeenCalledWith("child-question-1", "jwt-token", "run-1");
    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith("session-1", {
      prompt: "Continue the approved plan, run its declared tests, and update the PR.",
    });
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction?.type).not.toBe("agent_adjudication");
  });

  it("relays an answered parent question to a terminal Jules session exactly once", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      state: "COMPLETED",
      rawOutputs: [{ pullRequest: { url: "https://github.com/example/repository/pull/1" } }],
    } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({
      activities: [{
        id: "activity-question-answered-parent",
        createTime: "2026-08-08T00:00:00.000Z",
        agentMessaged: { agentMessage: "Should the canary bind the fake gh through agent environment?" },
      }],
    } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([
      {
        id: "rejected-no-pr-confirmation",
        kind: "request_confirmation",
        status: "rejected",
        idempotencyKey: "jules:no-pr-completion:issue-1:session-1",
      },
      {
        id: "answered-parent-question",
        kind: "ask_user_questions",
        status: "answered",
        idempotencyKey: "jules:agent-adjudication:issue-1:session-1:activity-question-answered-parent",
        result: { answers: [
          { questionId: "resolution", optionIds: ["answer"] },
          { questionId: "response", otherText: "Bind the fake gh directory in the agent environment, then rerun the canary." },
        ] },
      },
    ]);

    const result = await execute({
      ...baseContext,
      runtime: {
        ...baseContext.runtime,
        sessionParams: sessionCodec.encode({
          ...session,
          deliveredActivityIds: ["activity-question-answered-parent"],
        }),
      },
    } as AdapterExecutionContext);

    expect(createJulesQuestionAdjudication).not.toHaveBeenCalled();
    expect(createJulesQuestionReviewInteraction).not.toHaveBeenCalled();
    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith("session-1", {
      prompt: "Bind the fake gh directory in the agent environment, then rerun the canary.",
    });
    expect(sessionCodec.decode(result.sessionParams!)).toMatchObject({
      deliveredFeedbackActivityId: "activity-question-answered-parent",
      deliveredFeedbackInteractionId: "answered-parent-question",
      pendingInteraction: undefined,
    });

    await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: result.sessionParams },
    } as AdapterExecutionContext);
    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("recreates exactly one typed recovery bridge for a delivered post-completion question cancelled by adapter cleanup", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "COMPLETED" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [
      { id: "completion-before-question", createTime: "2026-09-09T13:45:00.000Z", sessionCompleted: {} },
      {
        id: "delivered-terminal-question",
        createTime: "2026-09-09T13:45:01.000Z",
        agentMessaged: { agentMessage: "Which Vitest resolver should load the extracted package?" },
      },
    ] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "cancelled-terminal-parent",
      kind: "ask_user_questions",
      status: "cancelled",
      idempotencyKey: "jules:agent-adjudication:issue-1:session-1:delivered-terminal-question",
      result: { reason: "Superseded by terminal Jules completion" },
    }] as never);
    vi.mocked(createJulesAgentAdjudicationInteraction).mockResolvedValue({
      id: "recovery-parent-generation-one", status: "pending",
    });

    const result = await execute({
      ...baseContext,
      runtime: {
        ...baseContext.runtime,
        sessionParams: sessionCodec.encode({
          ...session,
          phase: "RUNNING",
          julesState: "COMPLETED",
          deliveredActivityIds: ["delivered-terminal-question"],
        }),
      },
    } as AdapterExecutionContext);

    expect(createJulesAgentAdjudicationInteraction).toHaveBeenCalledTimes(1);
    expect(createJulesAgentAdjudicationInteraction).toHaveBeenCalledWith(
      "issue-1", "session-1", "delivered-terminal-question",
      "Which Vitest resolver should load the extracted package?",
      "00000000-0000-4000-8000-000000000123", "jwt-token", "run-1", 1,
    );
    expect(createJulesQuestionAdjudication).toHaveBeenCalledWith(
      "issue-1", "00000000-0000-4000-8000-000000000123",
      "Which Vitest resolver should load the extracted package?",
      "jwt-token", "run-1", "company-1", "delivered-terminal-question", "session-1", 0, true,
    );
    expect(createJulesQuestionReviewInteraction).toHaveBeenCalledTimes(1);
    expect(JulesClient.prototype.sendMessage).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "agent_adjudication",
      paperclipInteractionId: "recovery-parent-generation-one",
      reviewerChildIssueId: "child-question-1",
      reviewerInteractionId: "child-form-1",
      adjudicationGeneration: 1,
    });
  });

  it("creates one fresh adjudication generation for a done child with prose", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_USER_FEEDBACK" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({
      activities: [{
        id: "activity-question-invalid-terminal",
        createTime: "2026-08-08T00:00:00.000Z",
        agentMessaged: { agentMessage: "Should I proceed?" },
      }],
    } as never);
    vi.mocked(getPaperclipIssue).mockResolvedValue({
      id: "adjudication-invalid", status: "done", assigneeAgentId: "00000000-0000-4000-8000-000000000123",
    } as never);
    vi.mocked(listIssueComments).mockResolvedValue([{
      id: "prose-review", body: "I reviewed the task and it looks fine.", authorAgentId: "00000000-0000-4000-8000-000000000123",
    }]);
    vi.mocked(createJulesQuestionAdjudication).mockResolvedValue({ id: "adjudication-replacement", status: "todo" } as never);

    const result = await execute({
      ...baseContext,
      runtime: {
        ...baseContext.runtime,
        sessionParams: sessionCodec.encode({
          ...session,
          pendingInteraction: {
            type: "agent_adjudication",
            julesActivityId: "activity-question-invalid-terminal",
            paperclipInteractionId: "visible-question-invalid",
            question: "Should I proceed?",
            adjudicationIssueId: "adjudication-invalid",
            reviewerAgentId: "00000000-0000-4000-8000-000000000123",
            createdAt: "2026-08-08T00:00:00.000Z",
          },
        }),
      },
    } as AdapterExecutionContext);

    expect(answerJulesAgentAdjudicationInteraction).not.toHaveBeenCalled();
    expect(JulesClient.prototype.sendMessage).not.toHaveBeenCalled();
    expect(createJulesQuestionAdjudication).toHaveBeenCalledWith(
      "issue-1", "00000000-0000-4000-8000-000000000123", "Should I proceed?",
      "jwt-token", "run-1", "company-1", "activity-question-invalid-terminal", "session-1", 1,
    );
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "agent_adjudication", adjudicationIssueId: "adjudication-replacement", adjudicationGeneration: 1,
    });
    expect(sessionCodec.decode(result.sessionParams!)?.adjudicationRecoveryCount).toBe(1);
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

  it("migrates one legacy pending human plan card directly to one reviewer-owned native card", async () => {
    vi.mocked(getPaperclipInteraction).mockResolvedValue({
      id: "plan-1", kind: "request_confirmation", status: "pending",
      target: { type: "issue_document", key: "plan", revisionId: "revision-1" },
    });
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-1" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] } as never);

    const result = await execute({
      ...baseContext,
      agent: {
        ...baseContext.agent,
        adapterConfig: {
          ...baseContext.agent.adapterConfig,
          planReviewerAgentId: "00000000-0000-4000-8000-000000000011",
          planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000012",
        },
      },
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
    } as AdapterExecutionContext);

    expect(createJulesPlanReviewInteraction).not.toHaveBeenCalled();
    expect(createJulesQuestionAdjudication).toHaveBeenCalledWith(
      "issue-1", "**Jules plan**", "00000000-0000-4000-8000-000000000011", "jwt-token", "run-1", "company-1", "activity-plan", "session-1", 0, true, "plan",
    );
    expect(createJulesPlanReviewChildInteraction).toHaveBeenCalledWith(
      "child-question-1", "issue-1", "session-1",
      { documentId: "doc-1", revisionId: "revision-1", revisionNumber: 1 },
      "**Jules plan**", "luna", "00000000-0000-4000-8000-000000000011", "jwt-token", "run-1", "activity-plan",
    );
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "plan_native_review", paperclipInteractionId: "plan-review-child-form-1", reviewerChildIssueId: "child-question-1",
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
    expect(moveIssueToBlocked).not.toHaveBeenCalled();
    expect(moveIssueToInProgress).toHaveBeenCalledWith(
      "issue-1", "jwt-token", expect.stringContaining("regenerate"), "run-1",
    );
    expect(result.resultJson).toMatchObject({ issueStatus: "in_progress" });
  });
});
