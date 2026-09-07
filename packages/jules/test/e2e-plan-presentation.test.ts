import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/execute";
import { JulesClient } from "../src/server/jules-client";
import { sessionCodec } from "../src/server/session";
import {
  createJulesPlanApprovalInteraction,
  createJulesPlanReviewInteraction,
  createJulesAgentAdjudicationInteraction,
  createJulesQuestionAdjudication,
  createJulesQuestionReviewInteraction,
  activateInternalReviewIssue,
  saveJulesPlanDocument,
  listPaperclipInteractions,
  getPaperclipInteraction,
  withdrawPaperclipInteraction,
  moveIssueToBlocked,
  moveIssueToInProgress,
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
    createJulesAgentAdjudicationInteraction: vi.fn(),
    createJulesQuestionAdjudication: vi.fn(),
    createJulesQuestionReviewInteraction: vi.fn(),
    activateInternalReviewIssue: vi.fn(),
    saveJulesPlanDocument: vi.fn(),
    listPaperclipInteractions: vi.fn().mockResolvedValue([]),
    getPaperclipInteraction: vi.fn(),
    withdrawPaperclipInteraction: vi.fn(),
    moveIssueToBlocked: vi.fn(),
    moveIssueToInProgress: vi.fn(),
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
    vi.mocked(saveJulesPlanDocument).mockResolvedValue({ documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 });
    vi.mocked(createJulesPlanReviewInteraction).mockResolvedValue({ id: "native-plan-review-1", status: "pending", kind: "request_confirmation", planRevision: { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 } });
    vi.mocked(createJulesAgentAdjudicationInteraction).mockResolvedValue({ id: "question-card-1", status: "pending", kind: "ask_user_questions" });
    vi.mocked(createJulesQuestionAdjudication).mockResolvedValue({ id: "question-child-1" } as never);
    vi.mocked(createJulesQuestionReviewInteraction).mockResolvedValue({ id: "question-review-1" } as never);
  });

  it("creates one addressed native Luna plan-review card when the ladder is configured", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native",
      createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
    }] } as never);
    vi.mocked(createJulesPlanReviewInteraction).mockResolvedValue({
      id: "native-plan-review-1", status: "pending", kind: "request_confirmation",
      planRevision: { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
    });

    const result = await execute({
      ...baseContext,
      config: { ...baseContext.config, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" },
      agent: { ...baseContext.agent, adapterConfig: { ...baseContext.agent.adapterConfig, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" } },
    } as AdapterExecutionContext);

    expect(createJulesPlanReviewInteraction).toHaveBeenCalledWith(
      "issue-141", "session-141", { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
      expect.stringContaining("Implement the fix"), "luna", "00000000-0000-4000-8000-000000000001", "jwt-token", "run-1",
    );
    expect(createJulesPlanApprovalInteraction).not.toHaveBeenCalled();
    expect(result.sessionParams && sessionCodec.decode(result.sessionParams)?.pendingInteraction).toMatchObject({
      type: "plan_native_review", paperclipInteractionId: "native-plan-review-1", stage: "luna",
    });
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

    expect(createJulesPlanReviewInteraction).toHaveBeenCalledWith(
      "issue-141", "session-141", { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
      "Plan", "terra", "00000000-0000-4000-8000-000000000002", "jwt-token", "run-1",
    );
    expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({ stage: "terra", paperclipInteractionId: "native-plan-review-2" });
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
      "issue-141", "legacy-plan-card", expect.stringContaining("v2"), "jwt-token", "run-1",
    );
    expect(createJulesPlanReviewInteraction).toHaveBeenCalledTimes(1);
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      paperclipInteractionId: "native-plan-review-v2", stage: "luna",
    });
  });

  it("restores exactly one current plan card cancelled by the consumed PR rejection", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "replacement-plan-activity", createTime: "2026-09-06T01:25:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Apply reviewer feedback" }] } },
    }] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "cancelled-replacement-card", status: "cancelled", kind: "request_item_verdicts",
      result: {
        outcome: "withdrawn",
        reason: "Superseded by structured PR rejection for the same Jules session and immutable PR head.",
      },
    }]);
    vi.mocked(createJulesPlanReviewInteraction).mockResolvedValue({
      id: "restored-luna-card", status: "pending", kind: "request_item_verdicts",
      planRevision: { documentId: "doc-2", revisionId: "rev-2", revisionNumber: 2 },
    });

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        workerFeedbackDeliveryId: "native-review:old-pr-card:abc123",
        pendingInteraction: {
          type: "plan_native_review", protocolVersion: 2, julesActivityId: "replacement-plan-activity",
          paperclipInteractionId: "cancelled-replacement-card", question: "Replacement plan",
          planRevisionId: "rev-2", planRevisionNumber: 2, planDocumentId: "doc-2",
          reviewerAgentId: "00000000-0000-4000-8000-000000000001", stage: "luna",
          createdAt: "2026-09-06T01:25:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(createJulesPlanReviewInteraction).toHaveBeenCalledWith(
      "issue-141", "session-141", { documentId: "doc-2", revisionId: "rev-2", revisionNumber: 2 },
      "Replacement plan", "luna", "00000000-0000-4000-8000-000000000001", "jwt-token", "run-1", 1,
    );
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      paperclipInteractionId: "restored-luna-card", julesActivityId: "replacement-plan-activity", stage: "luna",
    });
  });

  it("restores a current plan card after adapter-owned PR-card supersession without a delivery checkpoint", async () => {
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
    vi.mocked(createJulesPlanReviewInteraction).mockResolvedValue({
      id: "restored-luna-card", status: "pending", kind: "request_item_verdicts",
      planRevision: { documentId: "doc-2", revisionId: "rev-2", revisionNumber: 2 },
    });

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

    expect(createJulesPlanReviewInteraction).toHaveBeenCalledWith(
      "issue-141", "session-141", { documentId: "doc-2", revisionId: "rev-2", revisionNumber: 2 },
      "Replacement plan", "luna", "00000000-0000-4000-8000-000000000001", "jwt-token", "run-1", 1,
    );
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      paperclipInteractionId: "restored-luna-card", julesActivityId: "replacement-plan-activity", stage: "luna",
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
      "issue-141", "legacy-terminal-plan-card", expect.stringContaining("v2"), "jwt-token", "run-1",
    );
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      paperclipInteractionId: "native-terminal-plan-v2", protocolVersion: 2,
    });
  });

  it("relays an answered v2 rejection to a terminal Jules session", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "COMPLETED", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [
      { id: "stale-question", createTime: "2026-08-30T00:02:00.000Z", agentMessaged: { agentMessage: "A stale provider question" } },
    ] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "native-terminal-plan-v2", status: "answered", kind: "request_item_verdicts",
      addresseeAgentId: "00000000-0000-4000-8000-000000000001",
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
