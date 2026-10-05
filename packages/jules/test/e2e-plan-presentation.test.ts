import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../src/server/execute";
import { JulesClient } from "../src/server/jules-client";
import { sessionCodec } from "../src/server/session";
import { observeQuestionChild } from "../src/server/question-bootstrap.js";
vi.mock("../src/server/question-bootstrap.js", async (original) => ({
  ...await original<typeof import("../src/server/question-bootstrap.js")>(),
  observeQuestionChild: vi.fn().mockResolvedValue({ kind: "waiting", childId: "child-question-1" }),
}));
import { loadStoredSession } from "../src/server/session-store";
import { parsePlanReviewInteraction } from "../src/server/plan-review-protocol";
import {
  createJulesPlanApprovalInteraction,
  createJulesPlanReviewInteraction,
  createJulesPlanReviewChildInteraction,
  enterNativePlanReviewStage,
  observeJulesChildPlanReview,
  createJulesAgentAdjudicationInteraction,
  createJulesQuestionAdjudication,
  createJulesQuestionReviewInteraction,
  activateInternalReviewIssue,
  clearJulesSessionMonitor,
  upsertJulesSessionHandle,
  saveJulesPlanDocument,
  listPaperclipInteractions,
  getPaperclipInteraction,
  getPaperclipIssue,
  getPaperclipJson,
  readJulesSessionHandleState,
  registerPullRequestWorkProduct,
  listIssueComments,
  withdrawPaperclipInteraction,
  moveIssueToBlocked,
  moveIssueToInProgress,
  scheduleJulesSessionMonitor,
  wakeJulesPlanReviewer,
  PaperclipClientError,
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
    questionReviewApi: vi.fn(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() })),
    createJulesPlanApprovalInteraction: vi.fn(),
    createJulesPlanReviewInteraction: vi.fn(),
    createJulesPlanReviewChildInteraction: vi.fn(),
    enterNativePlanReviewStage: vi.fn(),
    observeJulesChildPlanReview: vi.fn(),
    createJulesAgentAdjudicationInteraction: vi.fn(),
    createJulesQuestionAdjudication: vi.fn(),
    createJulesQuestionReviewInteraction: vi.fn(),
    activateInternalReviewIssue: vi.fn(),
    clearJulesSessionMonitor: vi.fn(),
    upsertJulesSessionHandle: vi.fn(),
    saveJulesPlanDocument: vi.fn(),
    listPaperclipInteractions: vi.fn().mockResolvedValue([]),
    getPaperclipInteraction: vi.fn(),
    getPaperclipIssue: vi.fn().mockImplementation(async id => id === "issue-141"
      ? { id, companyId: "company-1", assigneeAgentId: "agent-jules", status: "in_progress", executionBlocker: null } : null),
    getPaperclipJson: vi.fn(),
    readJulesSessionHandleState: vi.fn().mockResolvedValue(null),
    registerPullRequestWorkProduct: vi.fn(),
    listIssueComments: vi.fn().mockResolvedValue([]),
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`Unexpected network request in plan presentation fixture: ${String(input)}`);
    }));
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
    vi.mocked(getPaperclipIssue).mockImplementation(async id => id === "issue-141"
      ? { id, companyId: "company-1", assigneeAgentId: "agent-jules", status: "in_progress", executionBlocker: null }
      : { id: "question-child-1", status: "backlog" } as never);
    vi.mocked(getPaperclipJson).mockResolvedValue([]);
    vi.mocked(readJulesSessionHandleState).mockResolvedValue(null);
    vi.mocked(createJulesPlanReviewInteraction).mockResolvedValue({ id: "native-plan-review-1", status: "pending", kind: "request_confirmation", planRevision: { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 } });
    vi.mocked(createJulesPlanReviewChildInteraction).mockResolvedValue({ id: "native-plan-review-1", status: "pending", kind: "request_item_verdicts", planRevision: { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 } });
    vi.mocked(enterNativePlanReviewStage).mockResolvedValue({ stageId: "stage-1", reviewerAgentId: "00000000-0000-4000-8000-000000000001", ownerAgentId: "agent-jules" });
    vi.mocked(createJulesAgentAdjudicationInteraction).mockResolvedValue({ id: "question-card-1", status: "pending", kind: "ask_user_questions" });
    vi.mocked(createJulesQuestionAdjudication).mockResolvedValue({ id: "question-child-1" } as never);
    vi.mocked(createJulesQuestionReviewInteraction).mockResolvedValue({ id: "question-review-1" } as never);
  });

  it("creates one typed Luna plan-review form on the Jules parent when the ladder is configured", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native",
      createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
    }] } as never);
    vi.mocked(createJulesPlanReviewInteraction).mockResolvedValue({
      id: "native-plan-review-1", status: "pending", kind: "request_item_verdicts",
      planRevision: { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
    });

    const result = await execute({
      ...baseContext,
      config: { ...baseContext.config, requirePlanApproval: true, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" },
      agent: { ...baseContext.agent, adapterConfig: { ...baseContext.agent.adapterConfig, requirePlanApproval: true, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" } },
    } as AdapterExecutionContext);

    expect(enterNativePlanReviewStage).toHaveBeenCalledWith({
      issueId: "issue-141", revisionId: "rev-1", stage: "luna",
      reviewerAgentId: "00000000-0000-4000-8000-000000000001", ownerAgentId: "agent-jules",
      reviewRequest: expect.stringContaining("Implement the fix"), authToken: "jwt-token", runId: "run-1",
    });
    expect(createJulesPlanReviewInteraction).toHaveBeenCalledWith(
      "issue-141", "session-141", { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
      expect.stringContaining("Implement the fix"), "luna", "00000000-0000-4000-8000-000000000001", "jwt-token", "run-1", "act-plan-native",
    );
    const stageOrder = vi.mocked(enterNativePlanReviewStage).mock.invocationCallOrder[0];
    const cardOrder = vi.mocked(createJulesPlanReviewInteraction).mock.invocationCallOrder[0];
    expect(stageOrder).toBeDefined();
    expect(cardOrder).toBeDefined();
    if (stageOrder === undefined || cardOrder === undefined) {
      throw new Error("Expected both review stage entry and card creation to be invoked");
    }
    expect(cardOrder).toBeLessThan(stageOrder);
    expect(createJulesQuestionAdjudication).not.toHaveBeenCalled();
    expect(createJulesPlanReviewChildInteraction).not.toHaveBeenCalled();
    expect(createJulesPlanApprovalInteraction).not.toHaveBeenCalled();
    expect(activateInternalReviewIssue).not.toHaveBeenCalled();
    expect(wakeJulesPlanReviewer).not.toHaveBeenCalled();
    expect(result.sessionParams && sessionCodec.decode(result.sessionParams)?.pendingInteraction).toMatchObject({
      type: "plan_native_review", paperclipInteractionId: "native-plan-review-1", reviewIssueId: "issue-141", stage: "luna",
    });
  });

  it("checkpoints a v3 child review while leaving the Jules parent monitored", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement", description: "Verify" }] } },
    }] } as never);
    vi.mocked(observeJulesChildPlanReview).mockResolvedValue({ kind: "waiting", childId: "child-luna" });
    const startedAt = Date.now();
    const result = await execute({ ...baseContext, agent: { ...baseContext.agent, adapterConfig: {
      ...baseContext.agent.adapterConfig, pollCadenceSeconds: 900, planReviewBootstrapAgentId: "00000000-0000-4000-8000-000000000099",
    } } } as AdapterExecutionContext);
    expect(result.exitCode).toBe(0);
    expect(sessionCodec.decode(result.sessionParams!)?.childPlanReview).toMatchObject({ childId: "child-luna",
      identity: { version: 3, sessionId: "session-141", parentIssueId: "issue-141", stage: "luna", revisionId: "rev-1" } });
    expect(enterNativePlanReviewStage).not.toHaveBeenCalled();
    expect(createJulesPlanReviewInteraction).not.toHaveBeenCalled();
    expect(scheduleJulesSessionMonitor).toHaveBeenCalled();
    expect(new Date(result.retryNotBefore!).getTime()).toBeLessThan(startedAt + 90_000);
  });

  it("checkpoints a future v4 child for Jules to bootstrap on its own run even with a legacy manager configured", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement", description: "Verify" }] } },
    }] } as never);
    vi.mocked(observeJulesChildPlanReview).mockResolvedValue({ kind: "waiting", childId: "child-jules" });
    const result = await execute({ ...baseContext, agent: { ...baseContext.agent, adapterConfig: {
      ...baseContext.agent.adapterConfig, planReviewBootstrapAgentId: "00000000-0000-4000-8000-000000000099",
      planReviewBootstrapMode: "jules_v4",
    } } } as AdapterExecutionContext);
    expect(result.exitCode).toBe(0);
    expect(sessionCodec.decode(result.sessionParams!)?.childPlanReview).toMatchObject({ childId: "child-jules",
      identity: { version: 4, julesAgentId: "agent-jules", bootstrapAgentId: "agent-jules", stage: "luna" } });
    expect(createJulesPlanReviewInteraction).not.toHaveBeenCalled();
  });

  it.each(["waiting", "luna_approved", "terra_approved", "rejected"] as const)("advances the v3 child ladder from %s without reassigning the parent", async (step) => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement", description: "Verify" }] } },
    }] } as never);
    const identity = { version: 3 as const, companyId: "company-1", parentIssueId: "issue-141", sessionId: "session-141",
      activityId: "act-plan-native", documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1,
      stage: step === "terra_approved" ? "terra" as const : "luna" as const,
      reviewerAgentId: step === "terra_approved" ? "00000000-0000-4000-8000-000000000002" : "00000000-0000-4000-8000-000000000001",
      bootstrapAgentId: "00000000-0000-4000-8000-000000000099", julesAgentId: "agent-jules" };
    vi.mocked(observeJulesChildPlanReview).mockResolvedValueOnce(step === "waiting"
      ? { kind: "waiting", childId: "child-review" }
      : { kind: "answered", childId: "child-review", cardId: "typed-child-card", reviewerRunId: "review-run",
        verdict: step === "rejected" ? "reject" : "approve", ...(step === "rejected" ? { reason: "Add boundary-case coverage" } : {}) });
    vi.mocked(observeJulesChildPlanReview).mockResolvedValue({ kind: "waiting", childId: "terra-child" });
    const result = await execute({ ...baseContext, runtime: { ...baseContext.runtime,
      sessionParams: sessionCodec.encode({ ...session, phase: "WAITING_FOR_PLAN_APPROVAL", childPlanReview: { identity, childId: "child-review" } } as never),
    } } as AdapterExecutionContext);
    expect(result.exitCode).toBe(0);
    expect(observeJulesChildPlanReview).toHaveBeenCalledWith(identity, "child-review", "jwt-token", "run-1");
    expect(enterNativePlanReviewStage).not.toHaveBeenCalled();
    expect(createJulesPlanReviewInteraction).not.toHaveBeenCalled();
    const next = sessionCodec.decode(result.sessionParams!);
    switch (step) {
      case "waiting": expect(next?.childPlanReview?.childId).toBe("child-review"); break;
      case "luna_approved": expect(next?.childPlanReview).toMatchObject({ childId: "terra-child", identity: { stage: "terra" } }); break;
      case "terra_approved":
        expect(JulesClient.prototype.approvePlan).toHaveBeenCalledTimes(1);
        expect(next?.childPlanReview).toBeUndefined();
        expect(next?.planApprovedActivityId).toBe("act-plan-native");
        break;
      case "rejected":
        expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith("session-141", { prompt: expect.stringContaining("Add boundary-case coverage") },
          { kind: "request_revision", effectId: "revise:session-141:act-plan-native:typed-child-card", planActivityId: "act-plan-native" });
        expect(next?.childPlanReview).toBeUndefined();
        expect(next?.planReviewOutcome).toBe("revision_requested");
        break;
    }
  });

  it("keeps the original v4 strong child progressing across unapproved provider drift and outputless completion", async () => {
    const identity = { version: 4 as const, companyId: "company-1", parentIssueId: "issue-141", sessionId: "session-141",
      activityId: "act-plan-native", documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1,
      stage: "terra" as const, reviewerAgentId: "00000000-0000-4000-8000-000000000002",
      bootstrapAgentId: "agent-jules", julesAgentId: "agent-jules" };
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{ id: identity.activityId,
      planGenerated: { plan: { id: "provider-plan-1", steps: [{ title: "Implement" }] } } }] } as never);
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ id: identity.sessionId, state: "IN_PROGRESS", rawOutputs: [] } as never);
    vi.mocked(observeJulesChildPlanReview).mockResolvedValue({ kind: "answered", childId: "original-strong-child",
      cardId: "strong-card", reviewerRunId: "strong-run", verdict: "approve" });
    const first = await execute({ ...baseContext, runtime: { ...baseContext.runtime,
      sessionParams: sessionCodec.encode({ ...session, phase: "WAITING_FOR_PLAN_APPROVAL",
        childPlanReview: { identity, childId: "original-strong-child" } } as never),
    } } as AdapterExecutionContext);
    expect(first.exitCode).toBe(0);
    expect(first.resultJson).toMatchObject({ pending: true, planProviderObservation: { reason: "unverified_progress" } });
    const checkpoint = sessionCodec.decode(first.sessionParams!);
    expect(checkpoint?.julesState).toBe("IN_PROGRESS");
    expect(checkpoint?.childPlanReview?.childId).toBe("original-strong-child");
    expect(checkpoint?.planProviderObservation).toMatchObject({ sessionId: identity.sessionId, revisionId: identity.revisionId });
    expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
    expect(JulesClient.prototype.sendMessage).not.toHaveBeenCalled();
    expect(scheduleJulesSessionMonitor).toHaveBeenCalled();
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ id: identity.sessionId, state: "COMPLETED", rawOutputs: [] } as never);
    const second = await execute({ ...baseContext, runtime: { ...baseContext.runtime, sessionParams: first.sessionParams } } as AdapterExecutionContext);
    expect(second.exitCode).toBe(0);
    expect(sessionCodec.decode(second.sessionParams!)?.planProviderObservation).toBeUndefined();
    expect(sessionCodec.decode(second.sessionParams!)?.planApprovedActivityId).toBe(identity.activityId);
    expect(JulesClient.prototype.approvePlan).toHaveBeenCalledTimes(1);
  });

  it("rechecks provider eligibility after a strong verdict before issuing approval", async () => {
    const identity = { version: 4 as const, companyId: "company-1", parentIssueId: "issue-141", sessionId: "session-141",
      activityId: "act-plan-native", documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1,
      stage: "terra" as const, reviewerAgentId: "00000000-0000-4000-8000-000000000002",
      bootstrapAgentId: "agent-jules", julesAgentId: "agent-jules" };
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{ id: identity.activityId,
      planGenerated: { plan: { id: "provider-plan-1", steps: [{ title: "Implement" }] } } }] } as never);
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValueOnce({ id: identity.sessionId, state: "AWAITING_PLAN_APPROVAL" } as never)
      .mockResolvedValue({ id: identity.sessionId, state: "IN_PROGRESS", rawOutputs: [] } as never);
    vi.mocked(observeJulesChildPlanReview).mockResolvedValue({ kind: "answered", childId: "strong-child",
      cardId: "strong-card", reviewerRunId: "strong-run", verdict: "approve" });
    const result = await execute({ ...baseContext, runtime: { ...baseContext.runtime,
      sessionParams: sessionCodec.encode({ ...session, phase: "WAITING_FOR_PLAN_APPROVAL", childPlanReview: { identity, childId: "strong-child" } } as never),
    } } as AdapterExecutionContext);
    expect(result.exitCode).toBe(0);
    expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.planProviderObservation?.providerState).toBe("IN_PROGRESS");
  });

  it.each(["provider drift", "cancellation"])("does not issue approval when %s occurs during the final activity scan", async cause => {
    const identity = { version: 4 as const, companyId: "company-1", parentIssueId: "issue-141", sessionId: "session-141",
      activityId: "act-plan-native", documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1,
      stage: "terra" as const, reviewerAgentId: "00000000-0000-4000-8000-000000000002",
      bootstrapAgentId: "agent-jules", julesAgentId: "agent-jules" };
    const cancellation = new AbortController();
    let scans = 0;
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ id: identity.sessionId, state: "AWAITING_PLAN_APPROVAL" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockImplementation(async () => {
      if (++scans === 3) { // mirroring, initial complete boundary, final complete boundary
        if (cause === "cancellation") cancellation.abort();
        else vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ id: identity.sessionId, state: "IN_PROGRESS", rawOutputs: [] } as never);
      }
      return { activities: [{ id: identity.activityId, planGenerated: { plan: { id: "provider-plan-1", steps: [] } } }] } as never;
    });
    vi.mocked(observeJulesChildPlanReview).mockResolvedValue({ kind: "answered", childId: "strong-child",
      cardId: "strong-card", reviewerRunId: "strong-run", verdict: "approve" });
    const result = await execute({ ...baseContext, signal: cancellation.signal, runtime: { ...baseContext.runtime,
      sessionParams: sessionCodec.encode({ ...session, phase: "WAITING_FOR_PLAN_APPROVAL", childPlanReview: { identity, childId: "strong-child" } } as never),
    } } as AdapterExecutionContext);
    expect(result.exitCode).toBe(0);
    expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
  });

  it.each(["IN_PROGRESS", "AWAITING_PLAN_APPROVAL"] as const)("reconciles a started v3 strong approval from %s without replaying approvePlan", async (providerState) => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: providerState, id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { id: "provider-plan-1", steps: [{ title: "Implement", description: "Verify" }] } },
    }, ...(providerState === "IN_PROGRESS" ? [{ id: "provider-plan-approved", createTime: "2026-09-20T00:00:02.000Z",
      planApproved: { planId: "provider-plan-1" } }] : [])] } as never);
    const identity = { version: 3 as const, companyId: "company-1", parentIssueId: "issue-141", sessionId: "session-141",
      activityId: "act-plan-native", documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1,
      stage: "terra" as const, reviewerAgentId: "00000000-0000-4000-8000-000000000002",
      bootstrapAgentId: "00000000-0000-4000-8000-000000000099", julesAgentId: "agent-jules" };
    vi.mocked(observeJulesChildPlanReview).mockResolvedValue({ kind: "answered", childId: "terra-child",
      cardId: "typed-terra-card", reviewerRunId: "terra-run", verdict: "approve" });
    const result = await execute({ ...baseContext, runtime: { ...baseContext.runtime,
      sessionParams: sessionCodec.encode({ ...session, phase: "WAITING_FOR_PLAN_APPROVAL",
        childPlanReview: { identity, childId: "terra-child" }, lifecycleEffectJournal: { version: 1,
          effects: [{ effectId: "approve:session-141:rev-1", kind: "approve_plan",
            attempt: { kind: "started", startedAt: "2026-09-20T00:00:00.000Z" } }] },
      } as never),
    } } as AdapterExecutionContext);
    expect(result.exitCode).toBe(0);
    expect(observeJulesChildPlanReview).toHaveBeenCalledTimes(1);
    expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
    const next = sessionCodec.decode(result.sessionParams!);
    if (providerState === "IN_PROGRESS") {
      expect(next?.childPlanReview).toBeUndefined();
      expect(next?.lifecycleEffectJournal?.effects[0]?.attempt).toMatchObject({ kind: "confirmed" });
    } else {
      expect(next?.childPlanReview?.childId).toBe("terra-child");
      expect(next?.lifecycleEffectJournal?.effects[0]?.attempt).toMatchObject({ kind: "started" });
    }
  });

  it("confirms an interrupted v3 approval from the exact provider plan and PR without resending it", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "COMPLETED", id: "session-141",
      rawOutputs: [{ pullRequest: { url: "https://github.com/example/repository/pull/11",
        title: "Implement", baseRef: "main", headRef: "feature" } }] } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-09-19T00:00:00.000Z",
      planGenerated: { plan: { id: "provider-plan-1", steps: [{ title: "Implement" }] } },
    }, { id: "provider-approval-1", createTime: "2026-09-20T00:00:02.000Z",
      planApproved: { planId: "provider-plan-1" } }] } as never);
    const identity = { version: 3 as const, companyId: "company-1", parentIssueId: "issue-141", sessionId: "session-141",
      activityId: "act-plan-native", documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1,
      stage: "terra" as const, reviewerAgentId: "00000000-0000-4000-8000-000000000002",
      bootstrapAgentId: "00000000-0000-4000-8000-000000000099", julesAgentId: "agent-jules" };
    vi.mocked(observeJulesChildPlanReview).mockResolvedValue({ kind: "answered", childId: "gemini-child",
      cardId: "typed-gemini-card", reviewerRunId: "gemini-run", verdict: "approve" });
    const result = await execute({ ...baseContext, runtime: { ...baseContext.runtime,
      sessionParams: sessionCodec.encode({ ...session, phase: "WAITING_FOR_PLAN_APPROVAL",
        childPlanReview: { identity, childId: "gemini-child" }, lifecycleEffectJournal: { version: 1,
          effects: [{ effectId: "approve:session-141:rev-1", kind: "approve_plan",
            attempt: { kind: "started", startedAt: "2026-09-20T00:00:00.000Z" } }] },
      } as never),
    } } as AdapterExecutionContext);
    if (result.exitCode !== 0) throw new Error(`unexpected PR reconciliation result: ${result.errorCode ?? "unknown"}: ${result.errorMessage ?? "unknown"}`);
    expect(result.exitCode).toBe(0);
    expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
    const next = sessionCodec.decode(result.sessionParams!);
    expect(next?.childPlanReview).toBeUndefined();
    expect(next?.lifecycleEffectJournal?.effects[0]?.attempt).toMatchObject({ kind: "confirmed" });
  });

  it("clears a stale strong child after confirmed approval was saved before the crash", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "COMPLETED", id: "session-141",
      rawOutputs: [{ pullRequest: { url: "https://github.com/example/repository/pull/11" } }] } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-09-19T00:00:00.000Z",
      planGenerated: { plan: { id: "provider-plan-1", steps: [{ title: "Implement" }] } },
    }, { id: "provider-approval-1", createTime: "2026-09-20T00:00:02.000Z",
      planApproved: { planId: "provider-plan-1" } }] } as never);
    const identity = { version: 3 as const, companyId: "company-1", parentIssueId: "issue-141", sessionId: "session-141",
      activityId: "act-plan-native", documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1,
      stage: "terra" as const, reviewerAgentId: "00000000-0000-4000-8000-000000000002",
      bootstrapAgentId: "00000000-0000-4000-8000-000000000099", julesAgentId: "agent-jules" };
    vi.mocked(observeJulesChildPlanReview).mockResolvedValue({ kind: "answered", childId: "gemini-child",
      cardId: "typed-gemini-card", reviewerRunId: "gemini-run", verdict: "approve" });
    const result = await execute({ ...baseContext, runtime: { ...baseContext.runtime,
      sessionParams: sessionCodec.encode({ ...session, phase: "WAITING_FOR_PLAN_APPROVAL",
        childPlanReview: { identity, childId: "gemini-child" }, lifecycleEffectJournal: { version: 1,
          effects: [{ effectId: "approve:session-141:rev-1", kind: "approve_plan",
            attempt: { kind: "confirmed", receipt: "provider:approval-1" } }] },
      } as never),
    } } as AdapterExecutionContext);
    expect(result.exitCode).toBe(0);
    expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
    const next = sessionCodec.decode(result.sessionParams!);
    expect(next?.childPlanReview).toBeUndefined();
    expect(next?.planApprovedActivityId).toBe("act-plan-native");
    expect(next?.lifecycleEffectJournal?.effects[0]?.attempt).toEqual({ kind: "confirmed", receipt: "provider:approval-1" });
  });

  it("retires a stale strong child after a confirmed approval but before Jules publishes outputs", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "COMPLETED", id: "session-141", outputs: [] } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{ id: "act-plan-native",
      planGenerated: { plan: { id: "provider-plan-1", steps: [{ title: "Implement" }] } } }] } as never);
    const identity = { version: 3 as const, companyId: "company-1", parentIssueId: "issue-141", sessionId: "session-141",
      activityId: "act-plan-native", documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1,
      stage: "terra" as const, reviewerAgentId: "00000000-0000-4000-8000-000000000002",
      bootstrapAgentId: "00000000-0000-4000-8000-000000000099", julesAgentId: "agent-jules" };
    vi.mocked(observeJulesChildPlanReview).mockResolvedValue({ kind: "answered", childId: "gemini-child",
      cardId: "typed-gemini-card", reviewerRunId: "gemini-run", verdict: "approve" });
    const result = await execute({ ...baseContext, runtime: { ...baseContext.runtime,
      sessionParams: sessionCodec.encode({ ...session, phase: "WAITING_FOR_PLAN_APPROVAL",
        childPlanReview: { identity, childId: "gemini-child" }, lifecycleEffectJournal: { version: 1,
          effects: [{ effectId: "approve:session-141:rev-1", kind: "approve_plan",
            attempt: { kind: "confirmed", receipt: "approved:rev-1" } }] },
      } as never),
    } } as AdapterExecutionContext);
    expect(result.exitCode).toBe(0);
    expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
    const next = sessionCodec.decode(result.sessionParams!);
    expect(next?.childPlanReview).toBeUndefined();
    expect(next?.planApprovedActivityId).toBe("act-plan-native");
    expect(next?.lifecycleEffectJournal?.effects[0]?.attempt).toEqual({ kind: "confirmed", receipt: "approved:rev-1" });
  });

  it("keeps observing a started approval on an outputless completed session without replaying it", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "COMPLETED", id: "session-141", outputs: [] } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-09-19T00:00:00.000Z",
      planGenerated: { plan: { id: "provider-plan-1", steps: [{ title: "Implement" }] } },
    }] } as never);
    const identity = { version: 3 as const, companyId: "company-1", parentIssueId: "issue-141", sessionId: "session-141",
      activityId: "act-plan-native", documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1,
      stage: "terra" as const, reviewerAgentId: "00000000-0000-4000-8000-000000000002",
      bootstrapAgentId: "00000000-0000-4000-8000-000000000099", julesAgentId: "agent-jules" };
    vi.mocked(observeJulesChildPlanReview).mockResolvedValue({ kind: "answered", childId: "gemini-child",
      cardId: "typed-gemini-card", reviewerRunId: "gemini-run", verdict: "approve" });
    const result = await execute({ ...baseContext, runtime: { ...baseContext.runtime,
      sessionParams: sessionCodec.encode({ ...session, phase: "WAITING_FOR_PLAN_APPROVAL",
        childPlanReview: { identity, childId: "gemini-child" }, lifecycleEffectJournal: { version: 1,
          effects: [{ effectId: "approve:session-141:rev-1", kind: "approve_plan",
            attempt: { kind: "started", startedAt: "2026-09-20T00:00:00.000Z" } }] },
      } as never),
    } } as AdapterExecutionContext);
    expect(result.exitCode).toBe(0);
    expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
    const next = sessionCodec.decode(result.sessionParams!);
    expect(next?.childPlanReview?.childId).toBe("gemini-child");
    expect(next?.lifecycleEffectJournal?.effects[0]?.attempt).toMatchObject({ kind: "started" });
  });

  it("advances an exact typed Luna approval to the strong reviewer on an outputless completed Jules session", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "COMPLETED", id: "session-141", outputs: [] } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", planGenerated: { plan: { steps: [{ title: "Implement" }] } },
    }] } as never);
    const identity = { version: 3 as const, companyId: "company-1", parentIssueId: "issue-141", sessionId: "session-141",
      activityId: "act-plan-native", documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1,
      stage: "luna" as const, reviewerAgentId: "00000000-0000-4000-8000-000000000001",
      bootstrapAgentId: "00000000-0000-4000-8000-000000000099", julesAgentId: "agent-jules" };
    vi.mocked(observeJulesChildPlanReview).mockResolvedValue({ kind: "answered", childId: "luna-child",
      cardId: "luna-card", reviewerRunId: "luna-run", verdict: "approve" });
    const result = await execute({ ...baseContext, runtime: { ...baseContext.runtime,
      sessionParams: sessionCodec.encode({ ...session, phase: "WAITING_FOR_PLAN_APPROVAL", childPlanReview: { identity, childId: "luna-child" } } as never),
    } } as AdapterExecutionContext);
    expect(result.exitCode).toBe(0);
    expect(observeJulesChildPlanReview).toHaveBeenCalledWith(identity, "luna-child", "jwt-token", "run-1");
    expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.childPlanReview?.identity).toMatchObject({ stage: "terra" });
  });

  it("waits for the existing typed child verdict on a completed outputless provider", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "COMPLETED", id: "session-141", outputs: [] } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", planGenerated: { plan: { steps: [{ title: "Implement" }] } },
    }] } as never);
    const identity = { version: 3 as const, companyId: "company-1", parentIssueId: "issue-141", sessionId: "session-141",
      activityId: "act-plan-native", documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1,
      stage: "luna" as const, reviewerAgentId: "00000000-0000-4000-8000-000000000001",
      bootstrapAgentId: "00000000-0000-4000-8000-000000000099", julesAgentId: "agent-jules" };
    vi.mocked(observeJulesChildPlanReview).mockResolvedValue({ kind: "waiting", childId: "luna-child" });
    const result = await execute({ ...baseContext, runtime: { ...baseContext.runtime,
      sessionParams: sessionCodec.encode({ ...session, phase: "WAITING_FOR_PLAN_APPROVAL", childPlanReview: { identity, childId: "luna-child" } } as never),
    } } as AdapterExecutionContext);
    expect(result.exitCode).toBe(0);
    expect(observeJulesChildPlanReview).toHaveBeenCalledTimes(1);
    expect(sessionCodec.decode(result.sessionParams!)?.childPlanReview?.childId).toBe("luna-child");
  });

  it("journals and approves an answered strong v3 child on the same outputless completed Jules session", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "COMPLETED", id: "session-141", outputs: [] } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", planGenerated: { plan: { steps: [{ title: "Implement", description: "Verify" }] } },
    }] } as never);
    const identity = { version: 3 as const, companyId: "company-1", parentIssueId: "issue-141", sessionId: "session-141",
      activityId: "act-plan-native", documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1,
      stage: "terra" as const, reviewerAgentId: "00000000-0000-4000-8000-000000000002",
      bootstrapAgentId: "00000000-0000-4000-8000-000000000099", julesAgentId: "agent-jules" };
    vi.mocked(observeJulesChildPlanReview).mockResolvedValue({ kind: "answered", childId: "gemini-child",
      cardId: "typed-gemini-card", reviewerRunId: "gemini-run", verdict: "approve" });
    const result = await execute({ ...baseContext, runtime: { ...baseContext.runtime,
      sessionParams: sessionCodec.encode({ ...session, phase: "WAITING_FOR_PLAN_APPROVAL",
        childPlanReview: { identity, childId: "gemini-child" } } as never),
    } } as AdapterExecutionContext);
    if (result.exitCode !== 0) throw new Error(`unexpected completed-plan result: ${result.errorCode ?? "unknown"}: ${result.errorMessage ?? "unknown"}`);
    expect(result.exitCode).toBe(0);
    expect(JulesClient.prototype.approvePlan).toHaveBeenCalledTimes(1);
    expect(JulesClient.prototype.approvePlan).toHaveBeenCalledWith("session-141",
      { effectId: "approve:session-141:rev-1", planActivityId: "act-plan-native" });
    const next = sessionCodec.decode(result.sessionParams!);
    expect(next?.lifecycleEffectJournal?.effects).toContainEqual({ effectId: "approve:session-141:rev-1",
      kind: "approve_plan", attempt: { kind: "confirmed", receipt: "approved:rev-1" } });
    expect(next?.childPlanReview).toBeUndefined();
  });

  it("relays an exact Luna rejection to the same completed Jules session once", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "COMPLETED", id: "session-141", outputs: [] } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", planGenerated: { plan: { steps: [{ title: "Implement" }] } },
    }] } as never);
    const identity = { version: 3 as const, companyId: "company-1", parentIssueId: "issue-141", sessionId: "session-141",
      activityId: "act-plan-native", documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1,
      stage: "luna" as const, reviewerAgentId: "00000000-0000-4000-8000-000000000001",
      bootstrapAgentId: "00000000-0000-4000-8000-000000000099", julesAgentId: "agent-jules" };
    vi.mocked(observeJulesChildPlanReview).mockResolvedValue({ kind: "answered", childId: "luna-child",
      cardId: "typed-luna-card", reviewerRunId: "luna-run", verdict: "reject", reason: "State exact increment acceptance criteria" });
    const result = await execute({ ...baseContext, runtime: { ...baseContext.runtime,
      sessionParams: sessionCodec.encode({ ...session, phase: "WAITING_FOR_PLAN_APPROVAL", childPlanReview: { identity, childId: "luna-child" } } as never),
    } } as AdapterExecutionContext);
    expect(result.exitCode).toBe(0);
    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith("session-141",
      { prompt: expect.stringContaining("State exact increment acceptance criteria") },
      { kind: "request_revision", effectId: "revise:session-141:act-plan-native:typed-luna-card", planActivityId: "act-plan-native" });
    expect(sessionCodec.decode(result.sessionParams!)?.julesSessionId).toBe("session-141");
  });

  it("preserves the v3 checkpoint on a child protocol conflict instead of reporting provider polling failure", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ title: "Implement" }] } },
    }] } as never);
    vi.mocked(observeJulesChildPlanReview).mockRejectedValueOnce(new Error("Duplicate child review cards"));
    const identity = { version: 3 as const, companyId: "company-1", parentIssueId: "issue-141", sessionId: "session-141",
      activityId: "act-plan-native", documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1, stage: "luna" as const,
      reviewerAgentId: "luna", bootstrapAgentId: "orch", julesAgentId: "agent-jules" };
    const result = await execute({ ...baseContext, runtime: { ...baseContext.runtime,
      sessionParams: sessionCodec.encode({ ...session, childPlanReview: { identity, childId: "child" } } as never) },
    } as AdapterExecutionContext);
    expect(result.errorCode).toBe("native_child_plan_review_failed");
    expect(result.errorFamily).toBeNull();
    expect(result.clearSession).toBe(false);
    expect(sessionCodec.decode(result.sessionParams!)?.childPlanReview?.childId).toBe("child");
  });

  it("persists the exact pending Luna card before entering the ownership-changing stage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jules-stage-transfer-"));
    process.env.PAPERCLIP_JULES_SESSION_STORE_DIR = directory;
    try {
      vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
      vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
        id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
        planGenerated: { plan: { steps: [{ index: 0, title: "Implement", description: "Verify" }] } },
      }] } as never);
      vi.mocked(createJulesPlanReviewInteraction).mockResolvedValue({ id: "card-1", status: "pending", kind: "request_item_verdicts" });
      vi.mocked(enterNativePlanReviewStage).mockImplementation(async () => {
        const stored = await loadStoredSession("issue-141", "sources/github/example/repository", "main");
        expect(stored?.julesSessionId).toBe("session-141");
        expect(stored?.pendingInteraction).toMatchObject({
          type: "plan_native_review", protocolVersion: 2, paperclipInteractionId: "card-1",
          planRevisionId: "rev-1", stage: "luna",
        });
        throw new Error("simulated owner-run cancellation");
      });
      const result = await execute(baseContext);
      expect(createJulesPlanReviewInteraction).toHaveBeenCalledTimes(1);
      expect(result.clearSession).toBe(false);
      const stored = await loadStoredSession("issue-141", "sources/github/example/repository", "main");
      expect(stored?.pendingInteraction).toMatchObject({ paperclipInteractionId: "card-1", stage: "luna" });
    } finally {
      delete process.env.PAPERCLIP_JULES_SESSION_STORE_DIR;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("confirms the Terra card journal and pending pointer before transferring issue ownership", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jules-terra-transfer-"));
    process.env.PAPERCLIP_JULES_SESSION_STORE_DIR = directory;
    try {
      let stateAtTransfer: Awaited<ReturnType<typeof loadStoredSession>> = null;
      vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
      vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
        id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
        planGenerated: { plan: { steps: [{ index: 0, title: "Implement", description: "Verify" }] } },
      }] } as never);
      vi.mocked(listPaperclipInteractions).mockResolvedValue([{
        id: "native-plan-review-1", kind: "request_item_verdicts", status: "answered",
        addresseeAgentId: "00000000-0000-4000-8000-000000000001",
        idempotencyKey: "jules:plan-review:v2:issue-141:session-141:rev-1:luna",
        payload: { items: [{ id: "plan" }],
          target: { type: "issue_document", issueId: "issue-141", key: "plan", documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 } },
        result: { outcome: "resolved", complete: true, items: [{ id: "plan", verdict: "approve" }] },
        resolvedByAgentId: "00000000-0000-4000-8000-000000000001", resolvedByRunId: "luna-run-1",
      }] as never);
      vi.mocked(createJulesPlanReviewInteraction).mockResolvedValue({ id: "native-plan-review-2", kind: "request_item_verdicts", status: "pending" });
      vi.mocked(enterNativePlanReviewStage).mockImplementation(async () => {
        stateAtTransfer = await loadStoredSession("issue-141", "sources/github/example/repository", "main");
        throw new Error("simulated Terra transfer cancellation");
      });
      const result = await execute({
        ...baseContext,
        runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
          ...session, phase: "WAITING_FOR_PLAN_APPROVAL", pendingInteraction: {
            type: "plan_native_review", protocolVersion: 2, julesActivityId: "act-plan-native",
            question: "Plan", paperclipInteractionId: "native-plan-review-1", planDocumentId: "doc-1",
            planRevisionId: "rev-1", planRevisionNumber: 1,
            reviewerAgentId: "00000000-0000-4000-8000-000000000001", stage: "luna",
            createdAt: "2026-08-30T00:01:00.000Z",
          },
        } as never) },
      } as AdapterExecutionContext);
      expect(createJulesPlanReviewInteraction).toHaveBeenCalledTimes(1);
      expect(enterNativePlanReviewStage).toHaveBeenCalledTimes(1);
      expect(result.clearSession).toBe(false);
      expect(stateAtTransfer?.pendingInteraction).toMatchObject({
        stage: "terra", paperclipInteractionId: "native-plan-review-2", planRevisionId: "rev-1",
      });
      expect(stateAtTransfer?.lifecycleEffectJournal?.effects).toEqual(expect.arrayContaining([expect.objectContaining({
        effectId: "card:terra:rev-1", attempt: { kind: "confirmed", receipt: "native-plan-review-2" },
      })]));
    } finally {
      delete process.env.PAPERCLIP_JULES_SESSION_STORE_DIR;
      await rm(directory, { recursive: true, force: true });
    }
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
      addresseeAgentId: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: "jules:plan-review:v2:issue-141:session-141:rev-1:luna",
      createdAt: "2026-08-30T00:01:00.000Z",
    }]);
    vi.mocked(getPaperclipIssue).mockResolvedValue({ status: "in_progress" } as never);
    vi.mocked(getPaperclipInteraction).mockResolvedValue({
      id: "native-plan-review-1",
      status: "pending",
      kind: "request_item_verdicts",
    });
    vi.mocked(getPaperclipJson).mockResolvedValue([{
      id: "active-luna-run",
      agentId: "00000000-0000-4000-8000-000000000001",
      status: "running",
      startedAt: "2026-09-19T18:00:00.000Z",
      finishedAt: null,
      contextSnapshot: {
        issueId: "issue-141",
        interactionId: "native-plan-review-1",
        interactionKind: "request_item_verdicts",
      },
    }]);

    await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: first.sessionParams },
    } as AdapterExecutionContext);

    expect(createJulesQuestionAdjudication).not.toHaveBeenCalled();
    expect(createJulesPlanReviewInteraction).toHaveBeenCalledTimes(1);
    expect(createJulesPlanReviewChildInteraction).not.toHaveBeenCalled();
    expect(wakeJulesPlanReviewer).not.toHaveBeenCalled();
    expect(scheduleJulesSessionMonitor).not.toHaveBeenCalled();
    expect(clearJulesSessionMonitor).not.toHaveBeenCalled();
  });

  it("recovers the same pending Luna card after its bound reviewer run fails", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native",
      createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
    }] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "native-plan-review-1",
      status: "pending",
      kind: "request_item_verdicts",
      addresseeAgentId: "00000000-0000-4000-8000-000000000001",
    }]);
    vi.mocked(getPaperclipJson).mockResolvedValue([{
      id: "failed-luna-run",
      agentId: "00000000-0000-4000-8000-000000000001",
      status: "failed",
      startedAt: "2026-09-19T18:00:00.000Z",
      finishedAt: "2026-09-19T18:00:01.000Z",
      contextSnapshot: {
        issueId: "question-child-1",
        interactionId: "native-plan-review-1",
        interactionKind: "request_item_verdicts",
      },
    }]);

    await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: {
          type: "plan_native_review", protocolVersion: 2,
          julesActivityId: "act-plan-native", paperclipInteractionId: "native-plan-review-1",
          question: "Plan", planDocumentId: "doc-1", planRevisionId: "rev-1", planRevisionNumber: 1,
          reviewerAgentId: "00000000-0000-4000-8000-000000000001", stage: "luna",
          reviewerChildIssueId: "question-child-1", createdAt: "2026-09-19T18:00:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(createJulesQuestionAdjudication).not.toHaveBeenCalled();
    expect(createJulesPlanReviewChildInteraction).not.toHaveBeenCalled();
    expect(wakeJulesPlanReviewer).not.toHaveBeenCalled();
  });

  it("waits for an active addressed run whose card binding is only visible on the run detail", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
    }] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "native-plan-review-1", status: "pending", kind: "request_item_verdicts",
      addresseeAgentId: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: "jules:plan-review:v2:issue-141:session-141:rev-1:luna",
      createdAt: "2026-09-19T17:55:00.000Z",
      payload: {
        providerActivityId: "act-plan-native", items: [{ id: "plan" }],
        target: { type: "issue_document", issueId: "issue-141", documentId: "doc-1", key: "plan", revisionId: "rev-1", revisionNumber: 1 },
      },
    }]);
    vi.mocked(getPaperclipIssue).mockResolvedValue({ status: "todo" } as never);
    vi.mocked(getPaperclipJson).mockImplementation(async (path: string) => {
      if (path.includes("/heartbeat-runs?agentId=")) {
        // v2026.916.0 list projection omits the interaction binding.
        return [{
          id: "unrelated-luna-run", agentId: "00000000-0000-4000-8000-000000000001",
          status: "succeeded", startedAt: "2026-09-19T17:00:00.000Z", finishedAt: "2026-09-19T17:01:00.000Z",
          contextSnapshot: { issueId: "different-issue" },
        }, {
          id: "active-luna-run", agentId: "00000000-0000-4000-8000-000000000001",
          status: "running", startedAt: "2026-09-19T18:00:00.000Z", finishedAt: null,
          contextSnapshot: { issueId: "issue-141", taskId: "issue-141", wakeReason: "interaction_pending" },
        }] as never;
      }
      if (path === "/api/heartbeat-runs/active-luna-run") {
        return {
          id: "active-luna-run", agentId: "00000000-0000-4000-8000-000000000001",
          status: "running", startedAt: "2026-09-19T18:00:00.000Z", finishedAt: null,
          contextSnapshot: {
            issueId: "issue-141", interactionId: "native-plan-review-1",
            interactionKind: "request_item_verdicts",
          },
        } as never;
      }
      return [] as never;
    });

    await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: {
          type: "plan_native_review", protocolVersion: 2,
          julesActivityId: "act-plan-native", paperclipInteractionId: "native-plan-review-1",
          question: "Plan", planDocumentId: "doc-1", planRevisionId: "rev-1", planRevisionNumber: 1,
          reviewerAgentId: "00000000-0000-4000-8000-000000000001", stage: "luna",
          createdAt: "2026-09-19T17:55:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(wakeJulesPlanReviewer).not.toHaveBeenCalled();
    expect(getPaperclipJson).not.toHaveBeenCalledWith("/api/heartbeat-runs/unrelated-luna-run", expect.anything(), expect.anything());
    expect(createJulesPlanReviewInteraction).not.toHaveBeenCalled();
    expect(withdrawPaperclipInteraction).not.toHaveBeenCalled();
  });

  it("refuses dispatch when the reviewer-run list reaches its evidence limit", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
    }] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "native-plan-review-1", status: "pending", kind: "request_item_verdicts",
      addresseeAgentId: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: "jules:plan-review:v2:issue-141:session-141:rev-1:luna",
      createdAt: "2026-09-19T17:55:00.000Z",
      payload: {
        providerActivityId: "act-plan-native", items: [{ id: "plan" }],
        target: { type: "issue_document", issueId: "issue-141", documentId: "doc-1", key: "plan", revisionId: "rev-1", revisionNumber: 1 },
      },
    }]);
    vi.mocked(getPaperclipIssue).mockResolvedValue({ status: "todo" } as never);
    vi.mocked(getPaperclipJson).mockResolvedValue(Array.from({ length: 1000 }, (_, index) => ({
      id: `unrelated-${index}`, agentId: "00000000-0000-4000-8000-000000000001",
      status: "succeeded", startedAt: "2026-09-21T18:00:00.000Z", finishedAt: "2026-09-21T18:01:00.000Z",
      contextSnapshot: { issueId: `unrelated-issue-${index}`, interactionId: `unrelated-card-${index}`, interactionKind: "request_item_verdicts" },
    })));

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: {
          type: "plan_native_review", protocolVersion: 2,
          julesActivityId: "act-plan-native", paperclipInteractionId: "native-plan-review-1",
          question: "Plan", planDocumentId: "doc-1", planRevisionId: "rev-1", planRevisionNumber: 1,
          reviewerAgentId: "00000000-0000-4000-8000-000000000001", stage: "luna",
          createdAt: "2026-09-19T17:55:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(result.errorCode).toBe("paperclip_plan_review_evidence_unavailable");
    expect(wakeJulesPlanReviewer).not.toHaveBeenCalled();
  });

  it("recovers the same card when the pre-start cancellation binding is only on the run detail", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
    }] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "native-plan-review-1", status: "pending", kind: "request_item_verdicts",
      addresseeAgentId: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: "jules:plan-review:v2:issue-141:session-141:rev-1:luna",
      createdAt: "2026-09-19T17:55:00.000Z",
      payload: {
        providerActivityId: "act-plan-native", items: [{ id: "plan" }],
        target: { type: "issue_document", issueId: "issue-141", documentId: "doc-1", key: "plan", revisionId: "rev-1", revisionNumber: 1 },
      },
    }]);
    vi.mocked(getPaperclipIssue).mockResolvedValue({ status: "todo" } as never);
    vi.mocked(wakeJulesPlanReviewer).mockResolvedValue({ runId: "recovery-run-1" });
    vi.mocked(getPaperclipJson).mockImplementation(async (path: string) => {
      if (path.includes("/heartbeat-runs?agentId=")) {
        return [{
          id: "cancelled-prestart", agentId: "00000000-0000-4000-8000-000000000001",
          status: "cancelled", startedAt: null, finishedAt: "2026-09-21T17:27:47.341Z",
          errorCode: "issue_assignee_changed",
          contextSnapshot: { issueId: "issue-141", taskId: "issue-141", wakeReason: "interaction_pending" },
        }] as never;
      }
      if (path === "/api/heartbeat-runs/cancelled-prestart") {
        return {
          id: "cancelled-prestart", agentId: "00000000-0000-4000-8000-000000000001",
          status: "cancelled", startedAt: null, finishedAt: "2026-09-21T17:27:47.341Z",
          errorCode: "issue_assignee_changed",
          resultJson: { stopReason: "issue_assignee_changed" },
          contextSnapshot: {
            issueId: "issue-141", interactionId: "native-plan-review-1",
            interactionKind: "request_item_verdicts",
          },
        } as never;
      }
      return [] as never;
    });

    await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: {
          type: "plan_native_review", protocolVersion: 2,
          julesActivityId: "act-plan-native", paperclipInteractionId: "native-plan-review-1",
          question: "Plan", planDocumentId: "doc-1", planRevisionId: "rev-1", planRevisionNumber: 1,
          reviewerAgentId: "00000000-0000-4000-8000-000000000001", stage: "luna",
          createdAt: "2026-09-19T17:55:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(wakeJulesPlanReviewer).toHaveBeenCalledTimes(1);
    expect(wakeJulesPlanReviewer).toHaveBeenCalledWith(expect.objectContaining({
      childIssueId: "issue-141",
      interactionId: "native-plan-review-1",
      reviewerAgentId: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: "native-plan-review-dispatch-recovery:v1:issue-141:native-plan-review-1:00000000-0000-4000-8000-000000000001",
    }));
    expect(createJulesPlanReviewInteraction).not.toHaveBeenCalled();
    expect(withdrawPaperclipInteraction).not.toHaveBeenCalled();
  });

  it("replaces the card after a terminal run whose card binding is only on the run detail", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
    }] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "native-plan-review-1", status: "pending", kind: "request_item_verdicts",
      addresseeAgentId: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: "jules:plan-review:v2:issue-141:session-141:rev-1:luna",
      createdAt: "2026-09-19T17:55:00.000Z",
      payload: {
        providerActivityId: "act-plan-native", items: [{ id: "plan" }],
        target: { type: "issue_document", issueId: "issue-141", documentId: "doc-1", key: "plan", revisionId: "rev-1", revisionNumber: 1 },
      },
    }]);
    vi.mocked(getPaperclipIssue).mockResolvedValue({ status: "todo" } as never);
    vi.mocked(withdrawPaperclipInteraction).mockResolvedValue();
    vi.mocked(createJulesPlanReviewInteraction).mockResolvedValue({
      id: "native-plan-review-2", status: "pending", kind: "request_item_verdicts",
      planRevision: { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
    });
    vi.mocked(getPaperclipJson).mockImplementation(async (path: string) => {
      if (path.includes("/heartbeat-runs?agentId=")) {
        return [{
          id: "failed-luna-run", agentId: "00000000-0000-4000-8000-000000000001",
          status: "failed", startedAt: "2026-09-19T18:00:00.000Z", finishedAt: "2026-09-19T18:00:01.000Z",
          error: "transport_error",
          contextSnapshot: { issueId: "issue-141", taskId: "issue-141", wakeReason: "interaction_pending" },
        }] as never;
      }
      if (path === "/api/heartbeat-runs/failed-luna-run") {
        return {
          id: "failed-luna-run", agentId: "00000000-0000-4000-8000-000000000001",
          status: "failed", startedAt: "2026-09-19T18:00:00.000Z", finishedAt: "2026-09-19T18:00:01.000Z",
          error: "transport_error",
          contextSnapshot: {
            issueId: "issue-141", interactionId: "native-plan-review-1",
            interactionKind: "request_item_verdicts",
          },
        } as never;
      }
      return [] as never;
    });

    await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: {
          type: "plan_native_review", protocolVersion: 2,
          julesActivityId: "act-plan-native", paperclipInteractionId: "native-plan-review-1",
          question: "Plan", planDocumentId: "doc-1", planRevisionId: "rev-1", planRevisionNumber: 1,
          reviewerAgentId: "00000000-0000-4000-8000-000000000001", stage: "luna",
          createdAt: "2026-09-19T17:55:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(wakeJulesPlanReviewer).not.toHaveBeenCalled();
    expect(withdrawPaperclipInteraction).toHaveBeenCalledTimes(1);
    expect(createJulesPlanReviewInteraction).toHaveBeenCalledTimes(1);
    expect(createJulesPlanReviewInteraction).toHaveBeenCalledWith(
      "issue-141", "session-141", { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
      "Plan", "luna", "00000000-0000-4000-8000-000000000001", "jwt-token", "run-1", "act-plan-native", 1,
    );
  });

  const recoverEffectId = "recover-plan-dispatch:issue-141:native-plan-review-1:00000000-0000-4000-8000-000000000001";
  const recoverCard = {
    id: "native-plan-review-1", status: "pending", kind: "request_item_verdicts",
    addresseeAgentId: "00000000-0000-4000-8000-000000000001",
    idempotencyKey: "jules:plan-review:v2:issue-141:session-141:rev-1:luna",
    createdAt: "2026-09-19T17:55:00.000Z",
    payload: {
      providerActivityId: "act-plan-native", items: [{ id: "plan" }],
      target: { type: "issue_document", issueId: "issue-141", documentId: "doc-1", key: "plan", revisionId: "rev-1", revisionNumber: 1 },
    },
  };
  const recoverSessionInteraction = {
    type: "plan_native_review", protocolVersion: 2,
    julesActivityId: "act-plan-native", paperclipInteractionId: "native-plan-review-1",
    question: "Plan", planDocumentId: "doc-1", planRevisionId: "rev-1", planRevisionNumber: 1,
    reviewerAgentId: "00000000-0000-4000-8000-000000000001", stage: "luna",
    createdAt: "2026-09-19T17:55:00.000Z",
  };

  it("re-wakes the same card once when the confirmed recovery run died before start", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
    }] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([recoverCard]);
    vi.mocked(getPaperclipIssue).mockResolvedValue({ status: "todo" } as never);
    vi.mocked(wakeJulesPlanReviewer).mockResolvedValue({ runId: "recovery-run-2" });
    vi.mocked(getPaperclipJson).mockImplementation(async (path: string) => {
      if (path.includes("/heartbeat-runs?agentId=")) {
        return [{
          id: "recovery-run-1", agentId: "00000000-0000-4000-8000-000000000001",
          status: "cancelled", startedAt: null, finishedAt: "2026-09-21T18:00:00.000Z",
          errorCode: "issue_assignee_changed",
          contextSnapshot: { issueId: "issue-141", interactionId: "native-plan-review-1", interactionKind: "request_item_verdicts" },
        }] as never;
      }
      return [] as never;
    });

    await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: recoverSessionInteraction,
        lifecycleEffectJournal: {
          version: 1,
          effects: [{
            effectId: recoverEffectId, kind: "recover_plan_dispatch",
            attempt: { kind: "confirmed", receipt: "recovery-run-1" },
          }],
        },
      }) },
    } as AdapterExecutionContext);

    expect(wakeJulesPlanReviewer).toHaveBeenCalledTimes(1);
    expect(wakeJulesPlanReviewer).toHaveBeenCalledWith(expect.objectContaining({
      childIssueId: "issue-141",
      interactionId: "native-plan-review-1",
      idempotencyKey: "native-plan-review-dispatch-recovery:v1:issue-141:native-plan-review-1:00000000-0000-4000-8000-000000000001:attempt:2",
    }));
    expect(moveIssueToBlocked).not.toHaveBeenCalled();
  });

  it("fails closed after the bounded re-wake also dies before start", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
    }] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([recoverCard]);
    vi.mocked(getPaperclipIssue).mockResolvedValue({ status: "todo" } as never);
    vi.mocked(getPaperclipJson).mockImplementation(async (path: string) => {
      if (path.includes("/heartbeat-runs?agentId=")) {
        return [{
          id: "recovery-run-2", agentId: "00000000-0000-4000-8000-000000000001",
          status: "cancelled", startedAt: null, finishedAt: "2026-09-21T19:00:00.000Z",
          errorCode: "issue_assignee_changed",
          contextSnapshot: { issueId: "issue-141", interactionId: "native-plan-review-1", interactionKind: "request_item_verdicts" },
        }] as never;
      }
      return [] as never;
    });

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: recoverSessionInteraction,
        lifecycleEffectJournal: {
          version: 1,
          effects: [
            { effectId: recoverEffectId, kind: "recover_plan_dispatch", attempt: { kind: "confirmed", receipt: "recovery-run-1" } },
            { effectId: `${recoverEffectId}:attempt:2`, kind: "recover_plan_dispatch", attempt: { kind: "confirmed", receipt: "recovery-run-2" } },
          ],
        },
      }) },
    } as AdapterExecutionContext);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("native_plan_review_protocol_failure");
    expect(result.errorMessage).toContain("recovery for card native-plan-review-1 exhausted its bounded re-wake budget");
    expect(wakeJulesPlanReviewer).not.toHaveBeenCalled();
    expect(moveIssueToBlocked).toHaveBeenCalledWith("issue-141", "jwt-token", "run-1");
  });

  it("reports a cross-agent wake denial as routing failure without replacing the session", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
    }] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([recoverCard]);
    vi.mocked(getPaperclipIssue).mockResolvedValue({ status: "todo" } as never);
    vi.mocked(wakeJulesPlanReviewer).mockRejectedValue(new PaperclipClientError(403, "Agent can only invoke itself"));
    vi.mocked(getPaperclipJson).mockImplementation(async (path: string) => {
      if (path.includes("/heartbeat-runs?agentId=")) {
        return [{
          id: "cancelled-prestart", agentId: "00000000-0000-4000-8000-000000000001",
          status: "cancelled", startedAt: null, finishedAt: "2026-09-21T17:27:47.341Z",
          errorCode: "issue_assignee_changed",
          contextSnapshot: { issueId: "issue-141", interactionId: "native-plan-review-1", interactionKind: "request_item_verdicts" },
        }] as never;
      }
      return [] as never;
    });

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: recoverSessionInteraction,
      }) },
    } as AdapterExecutionContext);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("native_plan_review_routing_denied");
    expect(result.errorMessage).toContain("reviewer wake denied for card native-plan-review-1");
    const preserved = sessionCodec.decode(result.sessionParams!);
    expect(preserved?.julesSessionId).toBe("session-141");
    expect(preserved?.pendingInteraction).toMatchObject({ paperclipInteractionId: "native-plan-review-1", stage: "luna" });
    expect(createJulesPlanReviewInteraction).not.toHaveBeenCalled();
    expect(moveIssueToBlocked).toHaveBeenCalledWith("issue-141", "jwt-token", "run-1");
  });

  it("observes a live confirmed recovery run without waking again", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
    }] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([recoverCard]);
    vi.mocked(getPaperclipIssue).mockResolvedValue({ status: "todo" } as never);
    vi.mocked(getPaperclipJson).mockImplementation(async (path: string) => {
      if (path.includes("/heartbeat-runs?agentId=")) {
        return [{
          id: "recovery-run-1", agentId: "00000000-0000-4000-8000-000000000001",
          status: "running", startedAt: "2026-09-21T18:00:00.000Z", finishedAt: null,
          contextSnapshot: { issueId: "issue-141", interactionId: "native-plan-review-1", interactionKind: "request_item_verdicts" },
        }] as never;
      }
      return [] as never;
    });

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: recoverSessionInteraction,
        lifecycleEffectJournal: {
          version: 1,
          effects: [{
            effectId: recoverEffectId, kind: "recover_plan_dispatch",
            attempt: { kind: "confirmed", receipt: "recovery-run-1" },
          }],
        },
      }) },
    } as AdapterExecutionContext);

    expect(result.exitCode).toBe(0);
    expect(wakeJulesPlanReviewer).not.toHaveBeenCalled();
    expect(moveIssueToBlocked).not.toHaveBeenCalled();
  });

  it("does not wake when the card is answered by the time the write fence re-reads", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
    }] } as never);
    let cardAnswered = false;
    vi.mocked(listPaperclipInteractions).mockImplementation(async () =>
      [cardAnswered ? { ...recoverCard, status: "answered" as const } : recoverCard]);
    vi.mocked(getPaperclipIssue).mockResolvedValue({ status: "todo" } as never);
    let evidenceReads = 0;
    vi.mocked(getPaperclipJson).mockImplementation(async (path: string) => {
      if (path.includes("/heartbeat-runs?agentId=")) {
        evidenceReads += 1;
        // The initial evidence read triggers the race: by the fence re-read
        // the reviewer has already answered the card.
        if (evidenceReads === 1) cardAnswered = true;
        return [{
          id: "cancelled-prestart", agentId: "00000000-0000-4000-8000-000000000001",
          status: "cancelled", startedAt: null, finishedAt: "2026-09-21T17:27:47.341Z",
          errorCode: "issue_assignee_changed",
          contextSnapshot: { issueId: "issue-141", interactionId: "native-plan-review-1", interactionKind: "request_item_verdicts" },
        }] as never;
      }
      return [] as never;
    });

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: recoverSessionInteraction,
      }) },
    } as AdapterExecutionContext);

    expect(result.exitCode).toBe(0);
    expect(wakeJulesPlanReviewer).not.toHaveBeenCalled();
    expect(moveIssueToBlocked).not.toHaveBeenCalled();
  });

  it("does not wake when an addressed run started between the decision and the write fence", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
    }] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([recoverCard]);
    vi.mocked(getPaperclipIssue).mockResolvedValue({ status: "todo" } as never);
    let evidenceReads = 0;
    vi.mocked(getPaperclipJson).mockImplementation(async (path: string) => {
      if (path.includes("/heartbeat-runs?agentId=")) {
        evidenceReads += 1;
        if (evidenceReads === 1) {
          return [{
            id: "cancelled-prestart", agentId: "00000000-0000-4000-8000-000000000001",
            status: "cancelled", startedAt: null, finishedAt: "2026-09-21T17:27:47.341Z",
            errorCode: "issue_assignee_changed",
            contextSnapshot: { issueId: "issue-141", interactionId: "native-plan-review-1", interactionKind: "request_item_verdicts" },
          }] as never;
        }
        return [{
          id: "intervening-luna-run", agentId: "00000000-0000-4000-8000-000000000001",
          status: "running", startedAt: "2026-09-21T20:00:00.000Z", finishedAt: null,
          contextSnapshot: { issueId: "issue-141", interactionId: "native-plan-review-1", interactionKind: "request_item_verdicts" },
        }] as never;
      }
      return [] as never;
    });

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: recoverSessionInteraction,
      }) },
    } as AdapterExecutionContext);

    expect(result.exitCode).toBe(0);
    expect(wakeJulesPlanReviewer).not.toHaveBeenCalled();
    expect(moveIssueToBlocked).not.toHaveBeenCalled();
  });

  it("fails closed when a duplicate pending card appears at the write fence", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
    }] } as never);
    let duplicateVisible = false;
    vi.mocked(listPaperclipInteractions).mockImplementation(async () =>
      duplicateVisible ? [recoverCard, { ...recoverCard, id: "native-plan-review-dup" }] : [recoverCard]);
    vi.mocked(getPaperclipIssue).mockResolvedValue({ status: "todo" } as never);
    vi.mocked(getPaperclipJson).mockImplementation(async (path: string) => {
      if (path.includes("/heartbeat-runs?agentId=")) {
        duplicateVisible = true;
        return [{
          id: "cancelled-prestart", agentId: "00000000-0000-4000-8000-000000000001",
          status: "cancelled", startedAt: null, finishedAt: "2026-09-21T17:27:47.341Z",
          errorCode: "issue_assignee_changed",
          contextSnapshot: { issueId: "issue-141", interactionId: "native-plan-review-1", interactionKind: "request_item_verdicts" },
        }] as never;
      }
      return [] as never;
    });

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: recoverSessionInteraction,
      }) },
    } as AdapterExecutionContext);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("native_plan_review_protocol_failure");
    expect(result.errorMessage).toContain("ambiguous_canonical_card");
    expect(wakeJulesPlanReviewer).not.toHaveBeenCalled();
    expect(moveIssueToBlocked).toHaveBeenCalledWith("issue-141", "jwt-token", "run-1");
  });

  it("waits for an active child reviewer run, then migrates once before withdrawing the legacy card", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement", description: "Test" }] } },
    }] } as never);
    const legacyCard = {
      id: "legacy-child-card", sourceRunId: "parent-jules-run", status: "pending", kind: "request_item_verdicts",
      addresseeAgentId: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: "jules:plan-review:v2:issue-141:session-141:rev-1:luna",
      payload: {
        providerActivityId: "act-plan-native", items: [{ id: "plan" }],
        target: { type: "issue_document", issueId: "issue-141", documentId: "doc-1", key: "plan", revisionId: "rev-1", revisionNumber: 1 },
      },
    };
    const parentCard = { ...legacyCard, id: "parent-card", sourceRunId: "replacement-run" };
    vi.mocked(listPaperclipInteractions)
      .mockResolvedValueOnce([legacyCard])
      .mockResolvedValueOnce([legacyCard])
      .mockResolvedValueOnce([parentCard]);
    let reviewerRunActive = true;
    vi.mocked(getPaperclipJson).mockImplementation(async (path: string) => {
      if (path === "/api/heartbeat-runs/parent-jules-run") {
        return { id: "parent-jules-run", contextSnapshot: { issueId: "issue-141" } } as never;
      }
      if (path.includes("/heartbeat-runs?agentId=")) {
        return reviewerRunActive ? [{
          id: "active-child-review", agentId: "00000000-0000-4000-8000-000000000001",
          status: "running", startedAt: "2026-09-19T18:00:00.000Z", finishedAt: null,
          contextSnapshot: {
            issueId: "legacy-child", interactionId: "legacy-child-card",
            interactionKind: "request_item_verdicts",
          },
        }] as never : [] as never;
      }
      throw new Error("Reviewer-run listing is unavailable");
    });
    vi.mocked(createJulesPlanReviewInteraction).mockResolvedValue({
      id: "parent-card", status: "pending", kind: "request_item_verdicts",
      planRevision: { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
    });
    const legacySession = sessionCodec.encode({
      ...session,
      phase: "WAITING_FOR_PLAN_APPROVAL",
      pendingInteraction: {
        type: "plan_native_review", protocolVersion: 2,
        julesActivityId: "act-plan-native", paperclipInteractionId: "legacy-child-card",
        question: "Plan", planDocumentId: "doc-1", planRevisionId: "rev-1", planRevisionNumber: 1,
        reviewerAgentId: "00000000-0000-4000-8000-000000000001", stage: "luna",
        reviewerChildIssueId: "legacy-child", createdAt: "2026-09-19T18:00:00.000Z",
      },
    });

    const waiting = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: legacySession },
    } as AdapterExecutionContext);

    expect(createJulesPlanReviewInteraction).not.toHaveBeenCalled();
    expect(withdrawPaperclipInteraction).not.toHaveBeenCalled();

    reviewerRunActive = false;
    const migrated = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: waiting.sessionParams },
    } as AdapterExecutionContext);

    expect(createJulesPlanReviewInteraction).toHaveBeenCalledTimes(1);
    expect(createJulesPlanReviewInteraction).toHaveBeenCalledWith(
      "issue-141", "session-141", { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
      "Plan", "luna", "00000000-0000-4000-8000-000000000001", "jwt-token", "run-1", "act-plan-native",
    );
    expect(withdrawPaperclipInteraction).toHaveBeenCalledWith(
      "legacy-child", "legacy-child-card", expect.stringContaining("parent"), "jwt-token", "run-1",
    );
    expect(vi.mocked(createJulesPlanReviewInteraction).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(withdrawPaperclipInteraction).mock.invocationCallOrder[0]!,
    );
    expect(sessionCodec.decode(migrated.sessionParams!)?.pendingInteraction).toMatchObject({
      paperclipInteractionId: "parent-card", reviewIssueId: "issue-141", reviewerChildIssueId: undefined,
    });

    await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: migrated.sessionParams },
    } as AdapterExecutionContext);
    expect(createJulesPlanReviewInteraction).toHaveBeenCalledTimes(1);
    expect(withdrawPaperclipInteraction).toHaveBeenCalledTimes(1);
  });

  it("keeps a pending legacy child card visible when parent replacement creation fails", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement", description: "Test" }] } },
    }] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "legacy-child-card", sourceRunId: "parent-jules-run", status: "pending", kind: "request_item_verdicts",
      addresseeAgentId: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: "jules:plan-review:v2:issue-141:session-141:rev-1:luna",
      payload: {
        providerActivityId: "act-plan-native", items: [{ id: "plan" }],
        target: { type: "issue_document", issueId: "issue-141", documentId: "doc-1", key: "plan", revisionId: "rev-1", revisionNumber: 1 },
      },
    }]);
    vi.mocked(getPaperclipJson).mockImplementation(async (path: string) =>
      path === "/api/heartbeat-runs/parent-jules-run"
        ? { id: "parent-jules-run", contextSnapshot: { issueId: "issue-141" } } as never
        : [] as never,
    );
    vi.mocked(createJulesPlanReviewInteraction).mockRejectedValue(
      new PaperclipClientError(503, "Paperclip unavailable"),
    );

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: {
          type: "plan_native_review", protocolVersion: 2,
          julesActivityId: "act-plan-native", paperclipInteractionId: "legacy-child-card",
          question: "Plan", planDocumentId: "doc-1", planRevisionId: "rev-1", planRevisionNumber: 1,
          reviewerAgentId: "00000000-0000-4000-8000-000000000001", stage: "luna",
          reviewerChildIssueId: "legacy-child", createdAt: "2026-09-19T18:00:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(withdrawPaperclipInteraction).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      paperclipInteractionId: "legacy-child-card", reviewerChildIssueId: "legacy-child",
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
    expect(enterNativePlanReviewStage).toHaveBeenCalledWith({
      issueId: "issue-141", revisionId: "rev-1", stage: "terra",
      reviewerAgentId: "00000000-0000-4000-8000-000000000002", ownerAgentId: "agent-jules",
      reviewRequest: "Plan", authToken: "jwt-token", runId: "run-1",
    });
    expect(createJulesPlanReviewInteraction).toHaveBeenCalledWith(
      "issue-141", "session-141", { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
      "Plan", "terra", "00000000-0000-4000-8000-000000000002", "jwt-token", "run-1", "act-plan-native",
    );
    const stageOrder = vi.mocked(enterNativePlanReviewStage).mock.invocationCallOrder[0];
    const cardOrder = vi.mocked(createJulesPlanReviewInteraction).mock.invocationCallOrder[0];
    expect(stageOrder).toBeDefined();
    expect(cardOrder).toBeDefined();
    if (stageOrder === undefined || cardOrder === undefined) {
      throw new Error("Expected both Terra stage entry and card creation to be invoked");
    }
    expect(cardOrder).toBeLessThan(stageOrder);
    expect(wakeJulesPlanReviewer).not.toHaveBeenCalled();
    expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({ stage: "terra", paperclipInteractionId: "native-plan-review-2", reviewIssueId: "issue-141" });
    expect(sessionCodec.decode(result.sessionParams!)?.lifecycleEffectJournal).toEqual({
      version: 1,
      effects: [{
        effectId: "card:terra:rev-1",
        kind: "create_card",
        attempt: { kind: "confirmed", receipt: "native-plan-review-2" },
      }],
    });

    const persisted = sessionCodec.decode(result.sessionParams!);
    const recovered = await execute({
      ...baseContext,
      config: { ...baseContext.config, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" },
      agent: { ...baseContext.agent, adapterConfig: { ...baseContext.agent.adapterConfig, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001", planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002" } },
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...persisted!,
        pendingInteraction: {
          type: "plan_native_review", julesActivityId: "act-plan-native", paperclipInteractionId: "native-plan-review-1",
          question: "Plan", planRevisionId: "rev-1", planRevisionNumber: 1, planDocumentId: "doc-1",
          reviewerAgentId: "00000000-0000-4000-8000-000000000001", stage: "luna", createdAt: "2026-08-30T00:01:00.000Z",
        },
      }) },
    } as AdapterExecutionContext);

    expect(createJulesPlanReviewInteraction).toHaveBeenCalledTimes(1);
    expect(sessionCodec.decode(recovered.sessionParams!)?.pendingInteraction).toMatchObject({ stage: "terra", paperclipInteractionId: "native-plan-review-2" });
  });

  it("reconciles a started Luna-to-Terra card effect after an execute restart", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
    }] } as never);
    const lunaCard = {
        id: "native-plan-review-1", status: "answered", kind: "request_item_verdicts",
        idempotencyKey: "jules:plan-review:v2:issue-141:session-141:rev-1:luna",
        addresseeAgentId: "00000000-0000-4000-8000-000000000001",
        resolvedByAgentId: "00000000-0000-4000-8000-000000000001",
        resolvedByRunId: "run-luna-1",
        payload: {
          items: [{ id: "plan" }],
          target: { type: "issue_document", issueId: "issue-141", documentId: "doc-1", key: "plan", revisionId: "rev-1", revisionNumber: 1 },
        },
        result: { outcome: "resolved", complete: true, items: [{ id: "plan", verdict: "approve" }] },
      };
    vi.mocked(listPaperclipInteractions).mockResolvedValue([
      lunaCard,
      {
        id: "native-plan-review-2", status: "pending", kind: "request_item_verdicts",
        idempotencyKey: "jules:plan-review:v2:issue-141:session-141:rev-1:terra",
        addresseeAgentId: "00000000-0000-4000-8000-000000000002",
        payload: {
          items: [{ id: "plan" }],
          target: { type: "issue_document", issueId: "issue-141", documentId: "doc-1", key: "plan", revisionId: "rev-1", revisionNumber: 1 },
        },
      },
    ] as never);

    expect(parsePlanReviewInteraction(lunaCard, {
      issueId: "issue-141",
      sessionId: "session-141",
      documentId: "doc-1",
      revisionId: "rev-1",
      revisionNumber: 1,
      stage: "luna",
      reviewerAgentId: "00000000-0000-4000-8000-000000000001",
    })).toMatchObject({ kind: "v2", state: "answered", decision: { kind: "approve" } });

    const result = await execute({
      ...baseContext,
      config: {
        ...baseContext.config,
        planApprovalPolicy: "required",
        planReviewerAgentId: "00000000-0000-4000-8000-000000000001",
        planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002",
      },
      agent: {
        ...baseContext.agent,
        adapterConfig: {
          ...baseContext.agent.adapterConfig,
          planApprovalPolicy: "required",
          planReviewerAgentId: "00000000-0000-4000-8000-000000000001",
          planStrongReviewerAgentId: "00000000-0000-4000-8000-000000000002",
        },
      },
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
        lifecycleEffectJournal: {
          version: 1,
          effects: [{
            effectId: "card:terra:rev-1",
            kind: "create_card",
            attempt: { kind: "started", startedAt: "2026-09-20T00:00:00.000Z" },
          }],
        },
      }) },
    } as AdapterExecutionContext);

    expect(result.errorCode).toBeUndefined();
    expect(result.errorMessage).toBeUndefined();
    expect(createJulesPlanReviewInteraction).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      stage: "terra",
      paperclipInteractionId: "native-plan-review-2",
    });
  });

  it.each(["pendingInteraction", "deferredPlanReview"] as const)(
    "does not interpret a legacy reviewer comment from %s as a plan verdict",
    async (legacyField) => {
      vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
      vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
        id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
        planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
      }] } as never);
      vi.mocked(listIssueComments).mockResolvedValue([{
        authorAgentId: "00000000-0000-4000-8000-000000000002",
        body: '{"kind":"APPROVE"}',
      }] as never);

      const legacyReview = {
        type: "plan_agent_review" as const,
        julesActivityId: "act-plan-native",
        paperclipInteractionId: "legacy-plan-review-1",
        question: "Plan",
        planRevisionId: "rev-1",
        planRevisionNumber: 1,
        planDocumentId: "doc-1",
        reviewIssueId: "legacy-review-child-1",
        reviewerAgentId: "00000000-0000-4000-8000-000000000002",
        stage: "strong" as const,
        createdAt: "2026-08-30T00:01:00.000Z",
      };
      const result = await execute({
        ...baseContext,
        runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
          ...session,
          phase: "WAITING_FOR_PLAN_APPROVAL",
          ...(legacyField === "pendingInteraction"
            ? { pendingInteraction: legacyReview }
            : { deferredPlanReview: legacyReview }),
        }) },
      } as AdapterExecutionContext);

      expect(listIssueComments).not.toHaveBeenCalled();
      expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
      expect(result.sessionParams).toBeDefined();
    },
  );

  it.each([
    ["Luna", { planReviewerAgentId: undefined }],
    ["Terra", { planStrongReviewerAgentId: undefined }],
    ["both reviewers", { planReviewerAgentId: undefined, planStrongReviewerAgentId: undefined }],
  ])("fails closed when %s is not configured for required plan review", async (_label, missingReviewer) => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Implement the fix", description: "Add tests" }] } },
    }] } as never);
    vi.mocked(createJulesPlanApprovalInteraction).mockResolvedValue({
      id: "unexpected-human-plan-card",
      planRevision: { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
    } as never);

    const adapterConfig = {
      ...baseContext.agent.adapterConfig,
      ...missingReviewer,
    };
    const result = await execute({
      ...baseContext,
      config: { ...baseContext.config, requirePlanApproval: true, planApprovalPolicy: "required", ...missingReviewer },
      agent: { ...baseContext.agent, adapterConfig },
    } as AdapterExecutionContext);

    expect(result.errorCode).toBe("native_plan_review_agents_unconfigured");
    expect(createJulesPlanReviewInteraction).not.toHaveBeenCalled();
    expect(createJulesPlanApprovalInteraction).not.toHaveBeenCalled();
    expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
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
      "issue-141", "legacy-plan-card", expect.stringContaining("parent-owned"), "jwt-token", "run-1",
    );
    expect(createJulesPlanReviewInteraction).toHaveBeenCalledTimes(1);
    expect(createJulesPlanReviewChildInteraction).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      paperclipInteractionId: "native-plan-review-v2", reviewIssueId: "issue-141", stage: "luna",
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
    }, expect.objectContaining({ kind: "request_revision", planActivityId: "replacement-plan-activity" }));
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
    }, expect.objectContaining({ kind: "request_revision", planActivityId: "replacement-plan-activity" }));
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
      "issue-141", "legacy-terminal-plan-card", expect.stringContaining("parent-owned"), "jwt-token", "run-1",
    );
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      paperclipInteractionId: "native-terminal-plan-v2", reviewIssueId: "issue-141", protocolVersion: 2,
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

    expect(result.errorCode).toBeUndefined();
    expect(registerPullRequestWorkProduct).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)).toMatchObject({ phase: "WAITING_FOR_PLAN_APPROVAL" });
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "plan_native_review", julesActivityId: "act-plan-revised", stage: "luna",
    });
    expect(createJulesPlanReviewInteraction).toHaveBeenCalledWith(
      "issue-141", "session-141", { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
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
    expect(registerPullRequestWorkProduct).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)).toMatchObject({ phase: "WAITING_FOR_PLAN_APPROVAL" });
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "plan_native_review", julesActivityId: "act-recovery-plan", stage: "luna",
    });
    expect(createJulesPlanReviewInteraction).toHaveBeenCalledWith(
      "issue-141", "session-141", { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
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
    expect(createJulesPlanReviewInteraction).toHaveBeenCalledTimes(1);
    expect(createJulesPlanReviewChildInteraction).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "plan_native_review", julesActivityId: "act-ci-remediation-plan", stage: "luna",
    });
    expect(createJulesPlanReviewInteraction).toHaveBeenCalledWith(
      "issue-141", "session-141", { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
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
    expect(createJulesPlanReviewInteraction).toHaveBeenCalledTimes(1);
    expect(createJulesPlanReviewChildInteraction).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "plan_native_review", julesActivityId: "act-ci-remediation-plan", stage: "luna",
    });
    expect(createJulesPlanReviewInteraction).toHaveBeenCalledWith(
      "issue-141", "session-141", { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
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
    expect(createJulesPlanReviewInteraction).toHaveBeenCalledWith(
      "issue-141", "session-141", { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
      expect.stringContaining("Repair failed CI"), "luna", "00000000-0000-4000-8000-000000000001", "jwt-token", "run-1", "act-ci-remediation-plan",
    );
  });

  it("keeps polling the same terminal Jules session after a delivered plan-revision request", async () => {
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

    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeUndefined();
    expect(result.resultJson).toMatchObject({
      pending: true,
      provider: "jules",
      julesSessionId: "session-141",
    });
    expect(sessionCodec.decode(result.sessionParams!)).toMatchObject({
      phase: "WAITING_FOR_PLAN_APPROVAL",
      pendingPlanRevisionRequest: {
        interactionId: "expired-native-review-card",
        planActivityId: "act-plan-reviewed",
        state: "delivered",
      },
    });
    expect(scheduleJulesSessionMonitor).toHaveBeenCalledTimes(1);
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
    }, expect.objectContaining({ kind: "request_revision", planActivityId: "act-plan-native" }));
    expect(sessionCodec.decode(result.sessionParams!)?.planReviewOutcome).toBe("revision_requested");
    expect(sessionCodec.decode(result.sessionParams!)?.terminalActivityScan).toBeUndefined();
    expect(sessionCodec.decode(result.sessionParams!)?.lifecycleEffectJournal).toEqual({
      version: 1,
      effects: [{
        effectId: "revision:native-terminal-plan-v2:native-terminal-plan-v2",
        kind: "request_plan_revision",
        attempt: { kind: "confirmed", receipt: "revision-request:native-terminal-plan-v2" },
      }],
    });

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
    vi.mocked(createJulesPlanReviewInteraction).mockResolvedValue({
      id: "native-plan-review-2", status: "pending", kind: "request_item_verdicts",
      planRevision: { documentId: "doc-2", revisionId: "rev-2", revisionNumber: 2 },
    });

    const revised = await execute({
      ...baseContext,
      config: { ...baseContext.config, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001" },
      runtime: { ...baseContext.runtime, sessionParams: result.sessionParams },
    } as AdapterExecutionContext);

    expect(createJulesPlanReviewInteraction).toHaveBeenCalledWith(
      "issue-141", "session-141", { documentId: "doc-2", revisionId: "rev-2", revisionNumber: 2 },
      expect.stringContaining("Original plan"), "luna", "00000000-0000-4000-8000-000000000001", "jwt-token", "run-1", "act-plan-revised",
    );
    expect(sessionCodec.decode(revised.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "plan_native_review", julesActivityId: "act-plan-revised", stage: "luna",
    });
  });

  it("does not replay a started plan-revision request after restart without a provider receipt", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [{
      id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
      planGenerated: { plan: { steps: [{ index: 0, title: "Original plan", description: "Needs review" }] } },
    }] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "native-rejection-card", status: "answered", kind: "request_item_verdicts",
      addresseeAgentId: "00000000-0000-4000-8000-000000000001",
      resolvedByAgentId: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: "jules:plan-review:v2:issue-141:session-141:rev-1:luna",
      payload: {
        target: { type: "issue_document", issueId: "issue-141", documentId: "doc-1", key: "plan", revisionId: "rev-1", revisionNumber: 1 },
        items: [{ id: "plan" }],
      },
      result: { outcome: "resolved", complete: true, items: [{ id: "plan", verdict: "reject", reason: "Add the missing regression test." }] },
    }] as never);

    const result = await execute({
      ...baseContext,
      config: { ...baseContext.config, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001" },
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: {
          type: "plan_native_review", protocolVersion: 2, julesActivityId: "act-plan-native",
          paperclipInteractionId: "native-rejection-card", question: "Plan", planRevisionId: "rev-1",
          planRevisionNumber: 1, planDocumentId: "doc-1",
          reviewerAgentId: "00000000-0000-4000-8000-000000000001", stage: "luna",
          createdAt: "2026-08-30T00:00:00.000Z",
        },
        lifecycleEffectJournal: {
          version: 1,
          effects: [{
            effectId: "revision:native-rejection-card:native-rejection-card",
            kind: "request_plan_revision",
            attempt: { kind: "started", startedAt: "2026-09-20T00:00:00.000Z" },
          }],
        },
      }) },
    } as AdapterExecutionContext);

    expect(JulesClient.prototype.sendMessage).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "plan_native_review", paperclipInteractionId: "native-rejection-card",
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
    }, expect.objectContaining({ kind: "request_revision", planActivityId: "act-plan-native" }));
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
      resolvedByRunId: "luna-run-1",
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
    vi.mocked(getPaperclipJson).mockImplementation(async (path) => {
      if (path === "/api/heartbeat-runs/luna-run-1") {
        return {
          id: "luna-run-1", agentId: "00000000-0000-4000-8000-000000000001", status: "succeeded",
          contextSnapshot: { issueId: "issue-141" },
          resultJson: {
            stdout: `${JSON.stringify({
              type: "item.completed",
              item: {
                type: "mcp_tool_call", server: "paperclip_review", tool: "submit_native_review_verdict", status: "completed",
                result: { structured_content: { interactionId: "orphaned-native-plan-v2", verdict: "reject" } },
              },
            })}\n`,
          },
        } as never;
      }
      throw new Error("Reviewer-run listing is unavailable");
    });

    const result = await execute({
      ...baseContext,
      config: { ...baseContext.config, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001" },
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({ ...session, phase: "RUNNING" }) },
    } as AdapterExecutionContext);

    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith("session-141", {
      prompt: expect.stringContaining("Exercise both supported Node versions."),
    }, expect.objectContaining({ kind: "request_revision", planActivityId: "act-plan-native" }));
    expect(sessionCodec.decode(result.sessionParams!)?.planReviewOutcome).toBe("revision_requested");
  });

  it("relays an exact answered plan rejection when Jules reports feedback after a checkpoint restart", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_USER_FEEDBACK", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [
      {
        id: "act-plan-native", createTime: "2026-08-30T00:01:00.000Z",
        planGenerated: { plan: { steps: [{ index: 0, title: "Exercise the canary", description: "Add the focused behavior test." }] } },
      },
      {
        id: "act-plan-prompt", createTime: "2026-08-30T00:02:00.000Z",
        agentMessaged: { agentMessage: "Please review the plan." },
      },
    ] } as never);
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
        items: [{ id: "plan", verdict: "reject", reason: "State the canary behavior explicitly." }],
      },
    }]);

    const result = await execute({
      ...baseContext,
      config: { ...baseContext.config, planApprovalPolicy: "required", planReviewerAgentId: "00000000-0000-4000-8000-000000000001" },
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({ ...session, phase: "RUNNING" }) },
    } as AdapterExecutionContext);

    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith("session-141", {
      prompt: expect.stringContaining("State the canary behavior explicitly."),
    }, expect.objectContaining({ kind: "request_revision", planActivityId: "act-plan-native" }));
    expect(createJulesQuestionAdjudication).not.toHaveBeenCalled();
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
    expect(createJulesPlanReviewInteraction).toHaveBeenCalledWith(
      "issue-141", "session-141", { documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1 },
      expect.stringContaining("Run on Node 22 and 24"), "luna", "00000000-0000-4000-8000-000000000001", "jwt-token", "run-1", "act-plan-revised",
    );
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "plan_native_review", julesActivityId: "act-plan-revised", paperclipInteractionId: "revised-luna-card", reviewIssueId: "issue-141",
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
    expect(sessionCodec.decode(result.sessionParams!)?.lifecycleEffectJournal).toEqual({
      version: 1,
      effects: [{
        effectId: "approve:session-141:rev-1",
        kind: "approve_plan",
        attempt: { kind: "confirmed", receipt: "approved:session-141:rev-1" },
      }],
    });
  });

  it("preserves a legacy started Terra approval when generic progress has no exact approval witness", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "IN_PROGRESS", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "native-plan-review-terra", status: "accepted", kind: "request_item_verdicts",
      idempotencyKey: "jules:plan-review:v2:issue-141:session-141:rev-1:terra",
    }] as never);

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: {
          type: "plan_native_review", protocolVersion: 2, julesActivityId: "act-plan-native",
          paperclipInteractionId: "native-plan-review-terra", question: "Plan", planRevisionId: "rev-1",
          planRevisionNumber: 1, planDocumentId: "doc-1",
          reviewerAgentId: "00000000-0000-4000-8000-000000000002", stage: "terra",
          createdAt: "2026-08-30T00:01:00.000Z",
        },
        lifecycleEffectJournal: {
          version: 1,
          effects: [{
            effectId: "approve:session-141:rev-1",
            kind: "approve_plan",
            attempt: { kind: "started", startedAt: "2026-09-20T00:00:00.000Z" },
          }],
        },
      }) },
    } as AdapterExecutionContext);

    expect(result.errorCode).toBeUndefined();
    expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction?.paperclipInteractionId).toBe("native-plan-review-terra");
    expect(sessionCodec.decode(result.sessionParams!)?.lifecycleEffectJournal?.effects[0]?.attempt.kind).toBe("started");
    expect(scheduleJulesSessionMonitor).toHaveBeenCalled();
  });

  it("does not replay a started Terra approval without an attested native verdict", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "AWAITING_PLAN_APPROVAL", id: "session-141" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "native-plan-review-terra", status: "answered", kind: "request_item_verdicts",
      resolvedByAgentId: "00000000-0000-4000-8000-000000000002",
      resolvedByRunId: "terra-run-1",
      idempotencyKey: "jules:plan-review:v2:issue-141:session-141:rev-1:terra",
    }] as never);
    vi.mocked(getPaperclipJson).mockResolvedValue({
      id: "terra-run-1", agentId: "00000000-0000-4000-8000-000000000002", status: "succeeded",
      contextSnapshot: { issueId: "issue-141" },
      resultJson: { stdout: `${JSON.stringify({
        type: "item.completed",
        item: {
          type: "mcp_tool_call", server: "paperclip_review", tool: "submit_native_review_verdict", status: "completed",
          result: { structured_content: { interactionId: "native-plan-review-terra", verdict: "approve" } },
        },
      })}\n` },
    } as never);

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: sessionCodec.encode({
        ...session,
        phase: "WAITING_FOR_PLAN_APPROVAL",
        pendingInteraction: {
          type: "plan_native_review", protocolVersion: 2, julesActivityId: "act-plan-native",
          paperclipInteractionId: "native-plan-review-terra", question: "Plan", planRevisionId: "rev-1",
          planRevisionNumber: 1, planDocumentId: "doc-1",
          reviewerAgentId: "00000000-0000-4000-8000-000000000002", stage: "terra",
          createdAt: "2026-08-30T00:01:00.000Z",
        },
        lifecycleEffectJournal: {
          version: 1,
          effects: [{
            effectId: "approve:session-141:rev-1",
            kind: "approve_plan",
            attempt: { kind: "started", startedAt: "2026-09-20T00:00:00.000Z" },
          }],
        },
      }) },
    } as AdapterExecutionContext);

    expect(result.errorCode).toBeUndefined();
    expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "plan_native_review",
      paperclipInteractionId: "native-plan-review-terra",
    });
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
