import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/execute";
import { JulesClient } from "../src/server/jules-client";
import { sessionCodec } from "../src/server/session";
import {
  createJulesPlanApprovalInteraction,
  createJulesPlanReviewInteraction,
  createJulesPlanReviewChildInteraction,
  createJulesAgentAdjudicationInteraction,
  createJulesQuestionAdjudication,
  createJulesQuestionReviewInteraction,
  activateInternalReviewIssue,
  clearJulesSessionMonitor,
  upsertJulesSessionHandle,
  saveJulesPlanDocument,
  listPaperclipInteractions,
  getPaperclipInteraction,
  withdrawPaperclipInteraction,
  moveIssueToBlocked,
  moveIssueToInProgress,
  scheduleJulesSessionMonitor,
  wakeJulesPlanReviewer,
} from "../src/server/paperclip-client";

vi.mock("../src/server/jules-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/jules-client")>();
  const MockedJulesClient = vi.fn();
  MockedJulesClient.prototype.getSession = vi.fn();
  MockedJulesClient.prototype.getActivities = vi.fn();
  MockedJulesClient.prototype.listActivities = function(...args) { return this.getActivities(...args); };
  MockedJulesClient.prototype.sendMessage = vi.fn();
  MockedJulesClient.prototype.approvePlan = vi.fn();
  return { ...mod, JulesClient: MockedJulesClient };
});

vi.mock("../src/server/paperclip-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/paperclip-client")>();
  return {
    ...mod,
    createJulesPlanApprovalInteraction: vi.fn(),
    createJulesPlanReviewInteraction: vi.fn(),
    createJulesPlanReviewChildInteraction: vi.fn(),
    createJulesAgentAdjudicationInteraction: vi.fn(),
    createJulesQuestionAdjudication: vi.fn(),
    createJulesQuestionReviewInteraction: vi.fn(),
    activateInternalReviewIssue: vi.fn(),
    clearJulesSessionMonitor: vi.fn(),
    upsertJulesSessionHandle: vi.fn(),
    saveJulesPlanDocument: vi.fn(),
    listPaperclipInteractions: vi.fn().mockResolvedValue([]),
    getPaperclipInteraction: vi.fn(),
    withdrawPaperclipInteraction: vi.fn(),
    moveIssueToBlocked: vi.fn(),
    moveIssueToInProgress: vi.fn(),
    scheduleJulesSessionMonitor: vi.fn(),
    wakeJulesPlanReviewer: vi.fn(),
  };
});

describe.sequential("E2E Jules Plan Presentation & Interactive Resume Loop", () => {
  const session = {
    version: 1 as const,
    paperclipIssueId: "issue-141",
    promptHash: "hash-141",
    promptHashVersion: 2,
    repository: "example/repository",
    source: "sources/github/example/repository",
    baseBranch: "main",
    phase: "RUNNING" as const,
    sessionId: "session-141",
    julesSessionId: "session-141",
    julesSessionUrl: "https://jules.example/session-141",
    attempt: 1,
    failedSessions: [],
    createdAt: "2026-08-30T00:00:00.000Z",
  };

  const baseContext = {
    agent: {
      id: "agent-jules",
      companyId: "company-1",
      name: "Jules",
      adapterType: "jules",
      adapterConfig: {
        source: "sources/github/example/repository",
        repository: "example/repository",
        baseBranch: "main",
        planApprovalPolicy: "required",
        planReviewerAgentId: "00000000-0000-4000-8000-000000000001",
        planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002",
      },
    },
    runtime: {
      sessionId: "session-141",
      sessionParams: sessionCodec.encode(session),
      taskKey: "issue-141",
    },
    config: { env: { JULES_API_KEY: "test-key" } },
    context: { task: { id: "issue-141", title: "Cap SandboxDispatcher poolCache", description: "Fix leak" } },
    runId: "run-1",
    authToken: "jwt-token",
    onLog: vi.fn(),
  } as AdapterExecutionContext;

  beforeAll(() => {
    process.env.JULES_API_KEY = "test-key";
  });

  afterAll(() => {
    delete process.env.JULES_API_KEY;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(baseContext.agent.adapterConfig).forEach((key) => delete (baseContext.agent.adapterConfig as Record<string, unknown>)[key]);
    Object.assign(baseContext.agent.adapterConfig, {
      source: "sources/github/example/repository",
      repository: "example/repository",
      baseBranch: "main",
      planApprovalPolicy: "required",
      planReviewerAgentId: "00000000-0000-4000-8000-000000000001",
      planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002",
      questionReviewerAgentId: "00000000-0000-4000-8000-000000000002",
    });
    vi.mocked(moveIssueToBlocked).mockResolvedValue();
    vi.mocked(moveIssueToInProgress).mockResolvedValue();
    vi.mocked(scheduleJulesSessionMonitor).mockResolvedValue();
    vi.mocked(wakeJulesPlanReviewer).mockResolvedValue();
    vi.mocked(clearJulesSessionMonitor).mockResolvedValue();
    vi.mocked(upsertJulesSessionHandle).mockResolvedValue();
    vi.mocked(saveJulesPlanDocument).mockResolvedValue({ documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 });
    vi.mocked(createJulesPlanReviewInteraction).mockResolvedValue({ id: "native-plan-review-1", status: "pending", kind: "request_confirmation", planRevision: { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 } });
    vi.mocked(createJulesPlanReviewChildInteraction).mockResolvedValue({ id: "native-plan-review-1", status: "pending", kind: "request_item_verdicts", planRevision: { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 } });
    vi.mocked(createJulesAgentAdjudicationInteraction).mockResolvedValue({ id: "question-card-1", status: "pending", kind: "ask_user_questions" });
    vi.mocked(createJulesQuestionAdjudication).mockResolvedValue({ id: "question-child-1" } as never);
    vi.mocked(createJulesQuestionReviewInteraction).mockResolvedValue({ id: "question-review-1" } as never);
  });

  it("creates one typed Luna plan-review form on a reviewer-owned child when the ladder is configured", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native",
      createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
    }] } as never);
    vi.mocked(createJulesPlanReviewChildInteraction).mockResolvedValue({
      id: "native-plan-review-1", status: "pending", kind: "request_confirmation",
      planRevision: { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
    });

    const result = await execute({
      ...baseContext,
      config: { ...baseContext.config, requirePlanApproval: true, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" },
      agent: { ...baseContext.agent, adapterConfig: { ...baseContext.agent.adapterConfig, requirePlanApproval: true, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" } },
    } as AdapterExecutionContext);

    expect(createJulesPlanReviewChildInteraction).toHaveBeenCalledWith(
      "question-child-1", "issue-141", "session-141", { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
      expect.stringContaining("Implement the fix"), "luna", "00000000-0000-4000-8000-000000000001", "jwt-token", "run-1", "act-plan-native",
    );
    expect(createJulesPlanApprovalInteraction).not.toHaveBeenCalled();
    expect(activateInternalReviewIssue).not.toHaveBeenCalled();
    expect(wakeJulesPlanReviewer).toHaveBeenCalledWith({
      reviewerAgentId: "00000000-0000-4000-8000-000000000001",
      childIssueId: "question-child-1",
      interactionId: "native-plan-review-1",
      idempotencyKey: "jules:plan-review-wake:native-plan-review-1:0",
      authToken: "jwt-token",
      runId: "run-1",
    });
    expect(result.sessionParams && sessionCodec.decode(result.sessionParams)?.pendingInteraction).toMatchObject({
      type: "plan_native_review", paperclipInteractionId: "native-plan-review-1", reviewerChildIssueId: "question-child-1", stage: "luna",
    });
  });

  it("polls a pending Luna card without creating or waking another reviewer", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native",
      createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
    }] } as never);

    const first = await execute(baseContext as AdapterExecutionContext);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "native-plan-review-1",
      status: "pending",
      kind: "request_item_verdicts",
    }]);
    vi.mocked(getPaperclipInteraction).mockResolvedValue({
      id: "native-plan-review-1",
      status: "pending",
      kind: "request_item_verdicts",
    });

    await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: first.sessionParams },
    } as AdapterExecutionContext);

    expect(createJulesQuestionAdjudication).toHaveBeenCalledTimes(1);
    expect(createJulesPlanReviewChildInteraction).toHaveBeenCalledTimes(1);
    expect(wakeJulesPlanReviewer).toHaveBeenCalledTimes(1);
    expect(scheduleJulesSessionMonitor).toHaveBeenCalledTimes(2);
    expect(clearJulesSessionMonitor).not.toHaveBeenCalled();
  });

  it("preempts a pending native plan review when Jules emits a newer provider question", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [
      {
        id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
        planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
      },
      {
        id: "act-provider-question", createTime: "2026-08-30T00:02:00.000Z",
        agentMessaged: { agentMessage: "How should I resolve the packed test fixture?" },
      },
    ] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "native-plan-review-1", status: "pending", kind: "request_item_verdicts",
      idempotencyKey: "jules:plan-review:v2:issue-141:session-141:rev-1:luna",
    }]);

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: {
          type: "plan_native_review", protocolVersion: 2, julesActivityId: "act-plan-native",
          paperclipInteractionId: "native-plan-review-1", question: "Plan", planRevisionId: "rev-1",
          planRevisionNumber: 1, planDocumentId: "doc-1",
          reviewerAgentId: "00000000-0000-4000-8000-000000000001", stage: "luna",
          createdAt: "2026-08-30T00:01:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(withdrawPaperclipInteraction).toHaveBeenCalledWith(
      "issue-141", "native-plan-review-1", expect.stringContaining("provider question"), "jwt-token", "run-1",
    );
    expect(createJulesAgentAdjudicationInteraction).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toBeUndefined();
    expect(sessionCodec.decode(result.sessionParams!)?.supersededPlanActivityId).toBe("act-plan-native");

    vi.mocked(listPaperclipInteractions).mockResolvedValue([]);
    await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: result.sessionParams },
    } as AdapterExecutionContext);
    expect(createJulesAgentAdjudicationInteraction).toHaveBeenCalledTimes(1);
  });

  it("does not preempt a pending plan review with an older provider question", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [
      { id: "old-question", createTime: "2026-08-30T00:00:00.000Z", agentMessaged: { agentMessage: "Old question" } },
      { id: "new-plan", createTime: "2026-08-30T00:01:00.000Z", planGenerated: { plan: { steps: [{ index: 0, title: "Implement", description: "Test" }] } } },
    ] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "native-plan-review-1", status: "pending", kind: "request_item_verdicts",
      idempotencyKey: "jules:plan-review:v2:issue-141:session-141:rev-1:luna",
    }]);

    const result = await execute({ ...baseContext, runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
      ...session, phase: "WAITING_FOR_PLAN_APPROVAL", pendingInteraction: {
        type: "plan_native_review", protocolVersion: 2, julesActivityId: "new-plan", paperclipInteractionId: "native-plan-review-1", question: "Plan", planRevisionId: "rev-1", planRevisionNumber: 1, planDocumentId: "doc-1", reviewerAgentId: "00000000-0000-4000-8000-000000000001", stage: "luna", createdAt: "2026-08-30T00:01:00.000Z",
      },
    }) } } as AdapterExecutionContext);

    expect(withdrawPaperclipInteraction).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({ type: "plan_native_review", julesActivityId: "new-plan" });
  });

  it("does not reopen a previously approved plan when the same activity is replayed", async () => {
    const approvedActivityId = "act-plan-native";
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: approvedActivityId,
      createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Already approved" }] } },
    }] } as never);

    const result = await execute({
      ...baseContext,
      config: { ...baseContext.config, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" },
      agent: { ...baseContext.agent, adapterConfig: { ...baseContext.agent.adapterConfig, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" } },
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        planApprovedAt: "2026-08-30T00:02:00.000Z",
        planApprovedActivityId: approvedActivityId,
      }) },
    } as AdapterExecutionContext);

    expect(createJulesPlanReviewInteraction).not.toHaveBeenCalled();
    expect(result.resultJson).toMatchObject({ issueStatus: "in_progress" });
  });

  it("advances one answered Luna card to Terra without reading comments", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
    }] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "native-plan-review-1", status: "accepted", kind: "request_confirmation",
      idempotencyKey: "jules:plan-review:v1:issue-141:session-141:rev-1:luna",
    }]);
    vi.mocked(createJulesPlanReviewInteraction).mockResolvedValue({
      id: "native-plan-review-2", status: "pending", kind: "request_item_verdicts",
      planRevision: { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
    });

    const result = await execute({
      ...baseContext,
      config: { ...baseContext.config, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" },
      agent: { ...baseContext.agent, adapterConfig: { ...baseContext.agent.adapterConfig, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" } },
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: {
          type: "plan_native_review", julesActivityId: "act-plan-native", paperclipInteractionId: "native-plan-review-1",
          question: "Plan", planRevisionId: "rev-1", planRevisionNumber: 1, planDocumentId: "doc-1",
          reviewerAgentId: "00000000-0000-4000-8000-000000000001", stage: "luna", createdAt: "2026-08-30T00:01:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(sessionCodec.decode(result.sessionParams!)).toMatchObject({
      phase: "WAITING_FOR_PLAN_APPROVAL",
    });
    expect(createJulesPlanReviewChildInteraction).toHaveBeenCalledWith(
      "question-child-1", "issue-141", "session-141", { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
      "Plan", "terra", "00000000-0000-4000-8000-000000000002", "jwt-token", "run-1", "act-plan-native",
    );
    expect(wakeJulesPlanReviewer).toHaveBeenCalledWith({
      reviewerAgentId: "00000000-0000-4000-8000-000000000002",
      childIssueId: "question-child-1",
      interactionId: "native-plan-review-1",
      authToken: "jwt-token",
      runId: "run-1",
      idempotencyKey: "jules:plan-review-wake:native-plan-review-1:0",
    });
    expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({ stage: "terra", paperclipInteractionId: "native-plan-review-1", reviewerChildIssueId: "question-child-1" });
  });

  it("migrates one pending legacy plan card before waiting", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "legacy-plan-card", status: "pending", kind: "request_confirmation",
      idempotencyKey: "jules:plan-review:v1:issue-141:session-141:rev-1:luna",
    }]);
    vi.mocked(createJulesPlanReviewInteraction).mockResolvedValue({
      id: "native-plan-review-v2", status: "pending", kind: "request_item_verdicts",
      planRevision: { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
    });

    const result = await execute({
      ...baseContext,
      config: { ...baseContext.config, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" },
      agent: { ...baseContext.agent, adapterConfig: { ...baseContext.agent.adapterConfig, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" } },
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: {
          type: "plan_native_review", julesActivityId: "act-plan-native", paperclipInteractionId: "legacy-plan-card",
          question: "Plan", planRevisionId: "rev-1", planRevisionNumber: 1, planDocumentId: "doc-1",
          reviewerAgentId: "00000000-0000-4000-8000-000000000001", stage: "luna", createdAt: "2026-08-30T00:01:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(withdrawPaperclipInteraction).toHaveBeenCalledWith(
      "issue-141", "legacy-plan-card", expect.stringContaining("reviewer-owned"), "jwt-token", "run-1",
    );
    expect(createJulesPlanReviewChildInteraction).toHaveBeenCalledTimes(1);
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      paperclipInteractionId: "native-plan-review-1", reviewerChildIssueId: "question-child-1", stage: "luna",
    });
  });

  it("requests a fresh provider plan after Terra's native card expires without creating another Terra card", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "replacement-plan-activity", createTime: "2026-09-06T01:25:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Apply reviewer feedback" }] } },
    }] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "expired-terra-card", status: "expired", kind: "request_item_verdicts",
    }]);

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        workerFeedbackDeliveryId: "native-review:old-pr-card:abc123",
        pendingInteraction: {
          type: "plan_native_review", protocolVersion: 2, julesActivityId: "replacement-plan-activity",
          paperclipInteractionId: "expired-terra-card", reviewerChildIssueId: "expired-terra-child", question: "Replacement plan",
          planRevisionId: "rev-2", planRevisionNumber: 2, planDocumentId: "doc-2",
          reviewerAgentId: "00000000-0000-4000-8000-000000000002", stage: "terra",
          createdAt: "2026-09-06T01:25:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith("session-141", {
      prompt: expect.stringContaining("Publish a new plan activity"),
    });
    expect(createJulesQuestionAdjudication).not.toHaveBeenCalled();
    expect(createJulesPlanReviewChildInteraction).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)).toMatchObject({
      supersededPlanActivityId: "replacement-plan-activity",
      pendingInteraction: undefined,
    });

    await execute({ ...baseContext, runtime: { ...baseContext.runtime, sessionParams: result.sessionParams } } as AdapterExecutionContext);
    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("requests a fresh provider plan after an adapter-owned v2 cancellation", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "replacement-plan-activity", createTime: "2026-09-06T01:25:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Apply reviewer feedback" }] } },
    }] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "cancelled-replacement-card", status: "cancelled", kind: "request_item_verdicts",
      result: {
        outcome: "withdrawn",
        reason: "Superseded plan-review card: an immutable matching PR review card is the active native review authority.",
      },
    }]);
    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: {
          type: "plan_native_review", protocolVersion: 2, julesActivityId: "replacement-plan-activity",
          paperclipInteractionId: "cancelled-replacement-card", question: "Replacement plan",
          planRevisionId: "rev-2", planRevisionNumber: 2, planDocumentId: "doc-2",
          reviewerAgentId: "00000000-0000-4000-8000-000000000001", stage: "luna",
          createdAt: "2026-09-06T01:25:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith("session-141", {
      prompt: expect.stringContaining("Publish a new plan activity"),
    });
    expect(createJulesQuestionAdjudication).not.toHaveBeenCalled();
    expect(createJulesPlanReviewChildInteraction).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)).toMatchObject({
      supersededPlanActivityId: "replacement-plan-activity",
      pendingInteraction: undefined,
    });
  });

  it("migrates a pending legacy plan card even when Jules has reached terminal provider state", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "COMPLETED", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "legacy-terminal-plan-card", status: "pending", kind: "request_confirmation",
      idempotencyKey: "jules:plan-review:v1:issue-141:session-141:rev-1:luna",
    }]);
    vi.mocked(createJulesPlanReviewInteraction).mockResolvedValue({
      id: "native-terminal-plan-v2", status: "pending", kind: "request_item_verdicts",
      planRevision: { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
    });

    const result = await execute({
      ...baseContext,
      config: { ...baseContext.config, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" },
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: {
          type: "plan_native_review", julesActivityId: "act-plan-native", paperclipInteractionId: "legacy-terminal-plan-card",
          question: "Plan", planRevisionId: "rev-1", planRevisionNumber: 1, planDocumentId: "doc-1",
          reviewerAgentId: "00000000-0000-4000-8000-000000000001", stage: "luna", createdAt: "2026-08-30T00:01:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(withdrawPaperclipInteraction).toHaveBeenCalledWith(
      "issue-141", "legacy-terminal-plan-card", expect.stringContaining("reviewer-owned"), "jwt-token", "run-1",
    );
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      paperclipInteractionId: "native-plan-review-1", reviewerChildIssueId: "question-child-1", protocolVersion: 2,
    });
  });

  it("presents a revised terminal plan before entering PR remediation", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "COMPLETED", id: "session-141" } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([]);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-revised", createTime: "2026-08-30T00:02:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Revised plan", description: "Addresses Luna feedback" }] } },
    }] } as never);

    const result = await execute({
      ...baseContext,
      config: { ...baseContext.config, requirePlanApproval: true, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" },
      agent: { ...baseContext.agent, adapterConfig: { ...baseContext.agent.adapterConfig, requirePlanApproval: true, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" } },
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        currentPrUrl: "https://github.com/example/repository/pull/1",
        planReviewOutcome: "revision_requested",
        deliveredActivityIds: ["act-plan-revised"],
        terminalActivityScan: {
          sessionId: "session-141",
          complete: true,
          latestPlan: {
            id: "act-plan-revised", createTime: "2026-08-30T00:02:00.000Z",
            planGenerated: { plan: { steps: [{ index: 0, title: "Revised plan", description: "Addresses Luna feedback" }] } },
          },
        },
      }) },
    } as AdapterExecutionContext);

    expect(sessionCodec.decode(result.sessionParams!)).toMatchObject({ phase: "WAITING_FOR_PLAN_APPROVAL" });
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "plan_native_review", julesActivityId: "act-plan-revised", stage: "luna",
    });
    expect(createJulesPlanReviewChildInteraction).toHaveBeenCalledWith(
      "question-child-1", "issue-141", "session-141", { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
      expect.stringContaining("Revised plan"), "luna", "00000000-0000-4000-8000-000000000001", "jwt-token", "run-1", "act-plan-revised",
    );
  });

  it("presents the fresh plan from a terminal branch-bound plan-cycle recovery", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "COMPLETED", id: "session-141" } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([]);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-recovery-plan", createTime: "2026-09-14T03:00:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Recover plan review", description: "Present this fresh plan before changing PR #1" }] } },
    }] } as never);

    const result = await execute({
      ...baseContext,
      config: { ...baseContext.config, requirePlanApproval: true, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" },
      agent: { ...baseContext.agent, adapterConfig: { ...baseContext.agent.adapterConfig, requirePlanApproval: true, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" } },
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        currentPrUrl: "https://github.com/example/repository/pull/1",
        currentPrHeadSha: "a".repeat(40),
        currentPrHeadRef: "jules-existing-pr-branch",
        prRemediation: {
          originalSessionId: "terminal-session-141",
          prUrl: "https://github.com/example/repository/pull/1",
          headSha: "a".repeat(40),
          headRefName: "jules-existing-pr-branch",
          recoverySessionId: "session-141",
          startedAt: "2026-09-14T02:45:00.000Z",
          reason: "terminal_plan_revision_unavailable",
        },
      }) },
    } as AdapterExecutionContext);

    expect(result.errorCode).toBeUndefined();
    expect(sessionCodec.decode(result.sessionParams!)).toMatchObject({ phase: "WAITING_FOR_PLAN_APPROVAL" });
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "plan_native_review", julesActivityId: "act-recovery-plan", stage: "luna",
    });
    expect(createJulesPlanReviewChildInteraction).toHaveBeenCalledWith(
      "question-child-1", "issue-141", "session-141", { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
      expect.stringContaining("Recover plan review"), "luna", "00000000-0000-4000-8000-000000000001", "jwt-token", "run-1", "act-recovery-plan",
    );
  });

  it("presents the fresh plan from a terminal branch-bound CI remediation", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "COMPLETED", id: "session-141" } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([]);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-ci-remediation-plan", createTime: "2026-09-14T05:00:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Repair failed CI", description: "Inspect and repair the existing PR without opening another one" }] } },
    }] } as never);

    const result = await execute({
      ...baseContext,
      config: { ...baseContext.config, requirePlanApproval: true, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" },
      agent: { ...baseContext.agent, adapterConfig: { ...baseContext.agent.adapterConfig, requirePlanApproval: true, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" } },
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        currentPrUrl: "https://github.com/example/repository/pull/1",
        currentPrHeadSha: "a".repeat(40),
        currentPrHeadRef: "jules-existing-pr-branch",
        prRemediation: {
          originalSessionId: "terminal-session-141",
          prUrl: "https://github.com/example/repository/pull/1",
          headSha: "a".repeat(40),
          headRefName: "jules-existing-pr-branch",
          recoverySessionId: "session-141",
          startedAt: "2026-09-14T04:45:00.000Z",
          reason: "ci_failure",
        },
      }) },
    } as AdapterExecutionContext);

    expect(result.errorCode).toBeUndefined();
    expect(sessionCodec.decode(result.sessionParams!)).toMatchObject({ phase: "WAITING_FOR_PLAN_APPROVAL" });
    expect(createJulesPlanReviewChildInteraction).toHaveBeenCalledTimes(1);
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "plan_native_review", julesActivityId: "act-ci-remediation-plan", stage: "luna",
    });
    expect(createJulesPlanReviewChildInteraction).toHaveBeenCalledWith(
      "question-child-1", "issue-141", "session-141", { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
      expect.stringContaining("Repair failed CI"), "luna", "00000000-0000-4000-8000-000000000001", "jwt-token", "run-1", "act-ci-remediation-plan",
    );
  });

  it("does not let stale approval history bypass the first recovery-plan review", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "COMPLETED", id: "session-141" } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([]);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-ci-remediation-plan", createTime: "2026-09-14T05:00:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Repair failed CI", description: "Use the existing pull request" }] } },
    }] } as never);

    const result = await execute({
      ...baseContext,
      config: { ...baseContext.config, requirePlanApproval: true, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" },
      agent: { ...baseContext.agent, adapterConfig: { ...baseContext.agent.adapterConfig, requirePlanApproval: true, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" } },
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        currentPrUrl: "https://github.com/example/repository/pull/1",
        currentPrHeadSha: "a".repeat(40),
        currentPrHeadRef: "jules-existing-pr-branch",
        // A pre-fix relay could have recorded this activity as approved before
        // the native card existed. Recovery identity, not that stale marker,
        // owns the first plan gate for the replacement Jules session.
        planApprovedAt: "2026-09-14T04:50:00.000Z",
        planApprovedActivityId: "act-ci-remediation-plan",
        prRemediation: {
          originalSessionId: "terminal-session-141",
          prUrl: "https://github.com/example/repository/pull/1",
          headSha: "a".repeat(40),
          headRefName: "jules-existing-pr-branch",
          recoverySessionId: "session-141",
          startedAt: "2026-09-14T04:45:00.000Z",
          reason: "ci_failure",
        },
      }) },
    } as AdapterExecutionContext);

    expect(result.errorCode).toBeUndefined();
    expect(sessionCodec.decode(result.sessionParams!)).toMatchObject({ phase: "WAITING_FOR_PLAN_APPROVAL" });
    expect(createJulesPlanReviewChildInteraction).toHaveBeenCalledTimes(1);
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "plan_native_review", julesActivityId: "act-ci-remediation-plan", stage: "luna",
    });
    expect(createJulesPlanReviewChildInteraction).toHaveBeenCalledWith(
      "question-child-1", "issue-141", "session-141", { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
      expect.stringContaining("Repair failed CI"), "luna", "00000000-0000-4000-8000-000000000001", "jwt-token", "run-1", "act-ci-remediation-plan",
    );
  });

  it("retires a missing reviewer-card pointer from a terminal branch-bound CI remediation", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "COMPLETED", id: "session-141" } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([]);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-ci-remediation-plan", createTime: "2026-09-14T05:00:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Repair failed CI", description: "Use the existing pull request" }] } },
    }] } as never);

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        currentPrUrl: "https://github.com/example/repository/pull/1",
        currentPrHeadSha: "a".repeat(40),
        currentPrHeadRef: "jules-existing-pr-branch",
        prRemediation: {
          originalSessionId: "terminal-session-141", prUrl: "https://github.com/example/repository/pull/1",
          headSha: "a".repeat(40), headRefName: "jules-existing-pr-branch", recoverySessionId: "session-141",
          startedAt: "2026-09-14T04:45:00.000Z", reason: "ci_failure",
        },
        pendingInteraction: {
          type: "plan_native_review", protocolVersion: 2, julesActivityId: "act-ci-remediation-plan",
          paperclipInteractionId: "missing-native-card", reviewerChildIssueId: "missing-review-child",
          question: "Plan", planDocumentId: "doc-1", planRevisionId: "rev-1", planRevisionNumber: 1,
          reviewerAgentId: "00000000-0000-4000-8000-000000000001", stage: "luna", createdAt: "2026-09-14T04:50:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "plan_native_review", julesActivityId: "act-ci-remediation-plan", stage: "luna",
    });
    expect(createJulesPlanReviewChildInteraction).toHaveBeenCalledWith(
      "question-child-1", "issue-141", "session-141", { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
      expect.stringContaining("Repair failed CI"), "luna", "00000000-0000-4000-8000-000000000001", "jwt-token", "run-1", "act-ci-remediation-plan",
    );
  });

  it("starts one branch-bound recovery when a terminal Jules session cannot publish the requested plan revision", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "COMPLETED", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-reviewed", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Original plan", description: "Needs review" }] } },
    }] } as never);

    const result = await execute({
      ...baseContext,
      config: { ...baseContext.config, requirePlanApproval: true, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" },
      agent: { ...baseContext.agent, adapterConfig: { ...baseContext.agent.adapterConfig, requirePlanApproval: true, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" } },
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        currentPrUrl: "https://github.com/example/repository/pull/1",
        currentPrHeadSha: "a".repeat(40),
        currentPrHeadRef: "jules-existing-pr-branch",
        planReviewOutcome: "revision_requested",
        supersededPlanActivityId: "act-plan-reviewed",
        pendingPlanRevisionRequest: {
          interactionId: "expired-native-review-card",
          planActivityId: "act-plan-reviewed",
          state: "delivered",
        },
      }) },
    } as AdapterExecutionContext);

    expect(result.errorCode).toBe("jules_terminal_plan_recovery_scheduled");
    expect(sessionCodec.decode(result.sessionParams!)).toMatchObject({
      phase: "RETRY_SCHEDULED",
      prRemediation: {
        originalSessionId: "session-141",
        headRefName: "jules-existing-pr-branch",
        reason: "terminal_plan_revision_unavailable",
      },
    });
    expect(createJulesPlanReviewChildInteraction).not.toHaveBeenCalled();
  });

  it("relays an answered v2 rejection to a terminal Jules session", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "COMPLETED", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [
      {
        id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
        planGenerated: { plan: { steps: [{ index: 0, title: "Original plan", description: "Needs review" }] } },
      },
      { id: "stale-question", createTime: "2026-08-30T00:02:00.000Z", agentMessaged: { agentMessage: "A stale provider question" } },
    ] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "native-terminal-plan-v2", status: "answered", kind: "request_item_verdicts",
      addresseeAgentId: "00000000-0000-4000-8000-000000000001",
      resolvedByAgentId: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: "jules:plan-review:v2:issue-141:session-141:rev-1:luna",
      payload: {
        target: {
          type: "issue_document", issueId: "issue-141", documentId: "doc-1", key: "plan",
          revisionId: "rev-1", revisionNumber: 1,
        },
        items: [{ id: "plan" }],
      },
      result: {
        outcome: "resolved", complete: true,
        items: [{ id: "plan", verdict: "reject", reason: "Add the missing regression test." }],
      },
    }]);

    const result = await execute({
      ...baseContext,
      config: { ...baseContext.config, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001" },
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        deliveredActivityIds: ["stale-question"],
        // A terminal provider state normally avoids re-listing immutable history. A
        // rejection message is a provider-side mutation, so the cache must be
        // discarded before the next heartbeat can discover Jules's revised plan.
        terminalActivityScan: {
          sessionId: "session-141",
          complete: true,
          latestPlan: {
            id: "act-plan-native",
            createTime: "2026-08-30T00:01:00.000Z",
            planGenerated: { plan: { steps: [{ index: 0, title: "Original plan", description: "Needs review" }] } },
          },
        },
        pendingInteraction: {
          type: "plan_native_review", protocolVersion: 2, julesActivityId: "act-plan-native",
          paperclipInteractionId: "native-terminal-plan-v2", question: "Plan", planRevisionId: "rev-1",
          planRevisionNumber: 1, planDocumentId: "doc-1",
          reviewerAgentId: "00000000-0000-4000-8000-000000000001", stage: "luna",
          createdAt: "2026-08-30T00:01:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith("session-141", {
      prompt: expect.stringContaining("Add the missing regression test."),
    });
    expect(sessionCodec.decode(result.sessionParams!)?.planReviewOutcome).toBe("revision_requested");
    expect(sessionCodec.decode(result.sessionParams!)?.terminalActivityScan).toBeUndefined();

    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-revised", createTime: "2026-08-30T00:03:00.000Z",
      // Jules is allowed to make an unchanged plan explicit again. The native
      // review identity is the new activity/document revision, never a hash of
      // the prose or steps.
      planGenerated: { plan: { steps: [{ index: 0, title: "Original plan", description: "Needs review" }] } },
    }] } as never);
    vi.clearAllMocks();
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(saveJulesPlanDocument).mockResolvedValue({ documentId: "doc-2", revisionId: "rev-2", revisionNumber: 2 });
    vi.mocked(createJulesQuestionAdjudication).mockResolvedValue({ id: "question-child-2" } as never);
    vi.mocked(createJulesPlanReviewChildInteraction).mockResolvedValue({
      id: "native-plan-review-2", status: "pending", kind: "request_item_verdicts",
      planRevision: { documentId: "doc-2", revisionId: "rev-2", revisionNumber: 2 },
    });

    const revised = await execute({
      ...baseContext,
      config: { ...baseContext.config, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001" },
      runtime: { ...baseContext.runtime, sessionParams: result.sessionParams },
    } as AdapterExecutionContext);

    expect(createJulesPlanReviewChildInteraction).toHaveBeenCalledWith(
      "question-child-2", "issue-141", "session-141", { documentId: "doc-2", revisionId: "rev-2", revisionNumber: 2 },
      expect.stringContaining("Original plan"), "luna", "00000000-0000-4000-8000-000000000001", "jwt-token", "run-1", "act-plan-revised",
    );
    expect(sessionCodec.decode(revised.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "plan_native_review", julesActivityId: "act-plan-revised", stage: "luna",
    });
  });

  it("requests a fresh provider plan after a board-resolved card without treating it as Luna's verdict", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
    }] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "board-resolved-card", status: "answered", kind: "request_item_verdicts",
      addresseeAgentId: "00000000-0000-4000-8000-000000000001",
      resolvedByUserId: "local-board",
      idempotencyKey: "jules:plan-review:v2:issue-141:session-141:rev-1:luna",
      payload: {
        items: [{ id: "plan" }],
        target: { type: "issue_document", issueId: "issue-141", documentId: "doc-1", key: "plan", revisionId: "rev-1", revisionNumber: 1 },
      },
      result: { outcome: "resolved", complete: true, items: [{ id: "plan", verdict: "reject", reason: "Not a Luna verdict." }] },
    }]);
    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: {
          type: "plan_native_review", protocolVersion: 2, julesActivityId: "act-plan-native",
          paperclipInteractionId: "board-resolved-card", reviewerChildIssueId: "old-review-child",
          question: "Plan", planDocumentId: "doc-1", planRevisionId: "rev-1", planRevisionNumber: 1,
          reviewerAgentId: "00000000-0000-4000-8000-000000000001", stage: "luna", createdAt: "2026-08-30T00:01:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith("session-141", {
      prompt: expect.stringContaining("Publish a new plan activity"),
    });
    expect(createJulesQuestionAdjudication).not.toHaveBeenCalled();
    expect(createJulesPlanReviewChildInteraction).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)).toMatchObject({
      supersededPlanActivityId: "act-plan-native",
      pendingInteraction: undefined,
    });
  });

  it("recovers an answered native rejection after the owner run lost its card pointer", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "COMPLETED", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Exercise paperclipai run", description: "Run the canary." }] } },
    }] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "orphaned-native-plan-v2", status: "answered", kind: "request_item_verdicts",
      addresseeAgentId: "00000000-0000-4000-8000-000000000001",
      resolvedByAgentId: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: "jules:plan-review:v2:issue-141:session-141:rev-1:luna",
      payload: {
        providerActivityId: "act-plan-native",
        detailsMarkdown: "Recovered plan",
        items: [{ id: "plan" }],
        target: {
          type: "issue_document", issueId: "issue-141", documentId: "doc-1", key: "plan",
          revisionId: "rev-1", revisionNumber: 1,
        },
      },
      result: {
        outcome: "resolved", complete: true,
        items: [{ id: "plan", verdict: "reject", reason: "Exercise both supported Node versions." }],
      },
    }]);

    const result = await execute({
      ...baseContext,
      config: { ...baseContext.config, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001" },
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({ ...session, phase: "RUNNING" }) },
    } as AdapterExecutionContext);

    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith("session-141", {
      prompt: expect.stringContaining("Exercise both supported Node versions."),
    });
    expect(sessionCodec.decode(result.sessionParams!)?.planReviewOutcome).toBe("revision_requested");
  });

  it("presents a revised plan once instead of replaying an older answered rejection", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_USER_FEEDBACK", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [
      {
        id: "act-plan-original", createTime: "2026-08-30T00:01:00.000Z",
        planGenerated: { plan: { steps: [{ index: 0, title: "Original plan", description: "Missing Node coverage." }] } },
      },
      {
        id: "act-plan-revised", createTime: "2026-08-30T00:02:00.000Z",
        planGenerated: { plan: { steps: [{ index: 0, title: "Run on Node 22 and 24", description: "Use paperclipai run." }] } },
      },
      {
        id: "act-plan-prompt", createTime: "2026-08-30T00:03:00.000Z",
        agentMessaged: { agentMessage: "I have updated the plan. Please let me know if it is acceptable." },
      },
    ] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "original-luna-card", status: "answered", kind: "request_item_verdicts",
      addresseeAgentId: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: "jules:plan-review:v2:issue-141:session-141:rev-original:luna",
      payload: {
        detailsMarkdown: "Original plan", items: [{ id: "plan" }],
        target: { type: "issue_document", issueId: "issue-141", documentId: "doc-original", key: "plan", revisionId: "rev-original", revisionNumber: 1 },
      },
      result: { outcome: "resolved", complete: true, items: [{ id: "plan", verdict: "reject", reason: "Cover both Node versions." }] },
    }]);
    vi.mocked(createJulesPlanReviewInteraction).mockResolvedValue({
      id: "revised-luna-card", status: "pending", kind: "request_item_verdicts",
      planRevision: { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
    });

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({ ...session, phase: "RUNNING" }) },
    } as AdapterExecutionContext);

    expect(JulesClient.prototype.sendMessage).not.toHaveBeenCalled();
    expect(createJulesAgentAdjudicationInteraction).not.toHaveBeenCalled();
    expect(createJulesPlanReviewChildInteraction).toHaveBeenCalledWith(
      "question-child-1", "issue-141", "session-141", { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
      expect.stringContaining("Run on Node 22 and 24"), "luna", "00000000-0000-4000-8000-000000000001", "jwt-token", "run-1", "act-plan-revised",
    );
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "plan_native_review", julesActivityId: "act-plan-revised", paperclipInteractionId: "native-plan-review-1", reviewerChildIssueId: "question-child-1",
    });
  });

  it("does not relay an answered plan rejection after Jules has published a newer plan activity", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [
      {
        id: "act-plan-reviewed", createTime: "2026-08-30T00:01:00.000Z",
        planGenerated: { plan: { steps: [{ index: 0, title: "Old plan", description: "Missing Node coverage." }] } },
      },
      {
        id: "act-plan-newer", createTime: "2026-08-30T00:02:00.000Z",
        planGenerated: { plan: { steps: [{ index: 0, title: "Revised plan", description: "Run on both supported Node versions." }] } },
      },
    ] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "old-luna-card", status: "answered", kind: "request_item_verdicts",
      idempotencyKey: "jules:plan-review:v2:issue-141:session-141:rev-old:luna",
      payload: {
        providerActivityId: "act-plan-reviewed",
        items: [{ id: "plan" }],
        target: { type: "issue_document", issueId: "issue-141", documentId: "doc-old", key: "plan", revisionId: "rev-old", revisionNumber: 1 },
      },
      result: { outcome: "resolved", complete: true, items: [{ id: "plan", verdict: "reject", reason: "Cover both Node versions." }] },
    }] as never);
    // The reviewer child may already have been compacted after the verdict.
    // The persisted parent pointer must still be retired from provider identity.
    vi.mocked(listPaperclipInteractions).mockResolvedValue([]);

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: {
          type: "plan_native_review", protocolVersion: 2, julesActivityId: "act-plan-reviewed",
          paperclipInteractionId: "old-luna-card", question: "Old plan", planDocumentId: "doc-old",
          planRevisionId: "rev-old", planRevisionNumber: 1, reviewerAgentId: "00000000-0000-4000-8000-000000000001",
          stage: "luna", reviewerChildIssueId: "old-plan-child", createdAt: "2026-08-30T00:01:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(JulesClient.prototype.sendMessage).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toBeUndefined();
  });

  it("relays exactly one Jules approval from an answered Terra card", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "native-plan-review-terra", status: "accepted", kind: "request_confirmation",
      idempotencyKey: "jules:plan-review:v1:issue-141:session-141:rev-1:terra",
    }]);

    const result = await execute({
      ...baseContext,
      config: { ...baseContext.config, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" },
      agent: { ...baseContext.agent, adapterConfig: { ...baseContext.agent.adapterConfig, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" } },
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: {
          type: "plan_native_review", julesActivityId: "act-plan-native", paperclipInteractionId: "native-plan-review-terra",
          question: "Plan", planRevisionId: "rev-1", planRevisionNumber: 1, planDocumentId: "doc-1",
          reviewerAgentId: "00000000-0000-4000-8000-000000000002", stage: "terra", createdAt: "2026-08-30T00:01:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(JulesClient.prototype.approvePlan).toHaveBeenCalledTimes(1);
    expect(JulesClient.prototype.approvePlan).toHaveBeenCalledWith("session-141");
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toBeUndefined();
  });

  it("calls approvePlan and resumes execution when plan is approved by operator", async () => {
    vi.mocked(getPaperclipInteraction).mockResolvedValue({
      id: "plan-card-1",
      kind: "request_confirmation",
      status: "accepted",
      target: { type: "issue_document", key: "plan", revisionId: "rev-1" },
    });

    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      state: "IN_PROGRESS",
      id: "session-141",
    } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] } as never);

    const contextWithWake = {
      ...baseContext,
      runtime: {
        ...baseContext.runtime,
        sessionParams: sessionCodec.encode({
          ...session,
          phase: "WAITING_FOR_PLAN_APPROVAL",
          pendingInteraction: {
            type: "plan_approval",
            julesActivityId: "act-plan-1",
            paperclipInteractionId: "plan-card-1",
            question: "Proposed Plan",
            planDocumentId: "doc-1",
            planRevisionId: "rev-1",
            planRevisionNumber: 1,
            createdAt: "2026-08-30T00:01:00.000Z",
          },
        }),
      },
      context: {
        ...baseContext.context,
        interactionId: "plan-card-1",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      },
    } as AdapterExecutionContext;

    const result = await execute(contextWithWake);

    // Must call approvePlan on Jules client
    expect(JulesClient.prototype.approvePlan).toHaveBeenCalledWith("session-141");
    expect(moveIssueToBlocked).not.toHaveBeenCalled();

    // Session phase must resume to RUNNING with pendingInteraction cleared
    const decoded = sessionCodec.decode(result.sessionParams!);
    expect(decoded?.phase).toBe("RUNNING");
    expect(decoded?.pendingInteraction).toBeUndefined();
  });

});
