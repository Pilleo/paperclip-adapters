import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/execute.js";
import { JulesClient } from "../src/server/jules-client.js";
import { sessionCodec } from "../src/server/session.js";
import { listIssueComments, listPaperclipInteractions, readJulesSessionHandleState, withdrawPaperclipInteraction } from "../src/server/paperclip-client.js";

vi.mock("../src/server/ci-status.js", () => ({
  getPullRequestDetails: vi.fn().mockResolvedValue({ merged: false, ciStatus: "success", state: "OPEN", headSha: "abc123" }),
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
    readJulesSessionHandleState: vi.fn().mockResolvedValue(null),
    withdrawPaperclipInteraction: vi.fn().mockResolvedValue(undefined),
    scheduleJulesSessionMonitor: vi.fn().mockResolvedValue(undefined),
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
    currentPrUrl: "https://github.com/Pilleo/mazewall/pull/400",
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

  it("does not relay a comment-shaped review decision to Jules", async () => {
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
        body: 'PAPERCLIP_REVIEW_DECISION {"decision":"needs_work","comment":"Unbounded cache growth detected."}',
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
      onLog: vi.fn().mockResolvedValue(undefined),
    } as unknown as AdapterExecutionContext;

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(JulesClient.prototype.sendMessage).not.toHaveBeenCalled();
  });

  it("does not relay review prompts or plan/adjudication prose", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ state: "COMPLETED" } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] } as never);
    vi.mocked(listIssueComments).mockResolvedValue([
      { id: "prompt", body: "## 🔍 Code Review Request: inspect the PR", authorAgentId: "00000000-0000-4000-8000-000000000141" },
      { id: "plan", body: '{"kind":"ANSWER","answer":"Approve and proceed with the plan."}', authorAgentId: "00000000-0000-4000-8000-000000000141" },
      { id: "prose", body: "Code Review Verdict: REQUEST_CHANGES", authorAgentId: "00000000-0000-4000-8000-000000000141" },
    ]);
    const result = await execute({
      agent: { id: "jules-1", companyId: "c-1", name: "Jules", adapterType: "jules", adapterConfig: { ...adapterConfig, codeReviewerAgentIds: ["00000000-0000-4000-8000-000000000141"] } },
      runtime: { sessionParams: sessionCodec.encode(session) },
      context: { task: { id: "issue-141", title: "Review" } },
      config: adapterConfig,
      authToken: "mock-token",
      onLog: vi.fn().mockResolvedValue(undefined),
    } as unknown as AdapterExecutionContext);
    expect(result.exitCode).toBe(0);
    expect(JulesClient.prototype.sendMessage).not.toHaveBeenCalled();
  });

  it("relays a typed native rejection to a completed session with an existing PR exactly once", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-141", state: "IN_PROGRESS", url: "https://jules.example/session-141",
    });
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] });
    const completedSession = { ...session, phase: "COMPLETED" as const };
    const ctx = {
      agent: { id: "jules-1", companyId: "c-1", name: "Jules", adapterType: "jules", adapterConfig },
      runtime: { sessionParams: sessionCodec.encode(completedSession) },
      context: {
        task: { id: "issue-141", title: "Cap SandboxDispatcher poolCache growth" },
        payload: {
          workerFeedback: {
            version: 1,
            kind: "code_review_rejection",
            deliveryId: "review-feedback:issue-141:abc123:luna_review",
            issueId: "issue-141",
            reviewInteractionId: "interaction-review-1",
            reviewStage: "luna",
            prUrl: "https://github.com/Pilleo/mazewall/pull/400",
            headSha: "abc123",
            reason: "Add a bounded cache eviction test.",
            createdAt: "2026-09-03T00:00:00.000Z",
          },
        },
      },
      config: adapterConfig,
      authToken: "mock-token",
      onLog: vi.fn().mockResolvedValue(undefined),
    } as unknown as AdapterExecutionContext;

    const first = await execute(ctx);
    expect(first.exitCode).toBe(0);
    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledTimes(1);
    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith("session-141", expect.objectContaining({
      prompt: expect.stringContaining("Add a bounded cache eviction test."),
    }));

    const resumed = sessionCodec.decode(first.sessionParams);
    expect(resumed?.workerFeedbackDeliveryId).toBe("review-feedback:issue-141:abc123:luna_review");

    await execute({ ...ctx, runtime: { sessionParams: first.sessionParams } });
    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledTimes(1);
    expect(JulesClient.prototype.getSession).toHaveBeenCalled();
  });

  it("supersedes a stale Terra plan card before relaying a matching PR rejection", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-141", state: "COMPLETED", url: "https://jules.example/session-141",
    });
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] });
    vi.mocked(withdrawPaperclipInteraction).mockResolvedValue(undefined);
    const ctx = {
      agent: { id: "jules-1", companyId: "c-1", name: "Jules", adapterType: "jules", adapterConfig },
      runtime: { sessionParams: sessionCodec.encode({
        ...session,
        phase: "COMPLETED" as const,
        pendingInteraction: {
          type: "plan_native_review" as const, protocolVersion: 2 as const,
          julesActivityId: "plan-activity", paperclipInteractionId: "terra-plan-1",
          question: "Plan", planRevisionId: "revision-1", planRevisionNumber: 1,
          planDocumentId: "document-1", reviewerAgentId: "terra-1", stage: "terra" as const,
          createdAt: "2026-09-03T00:00:00.000Z",
        },
      }) },
      context: { task: { id: "issue-141", title: "Review" }, payload: { workerFeedback: {
        version: 1, kind: "code_review_rejection", deliveryId: "reject-1", issueId: "issue-141",
        reviewInteractionId: "luna-reject-1", reviewStage: "luna", prUrl: session.currentPrUrl,
        headSha: "abc123", reason: "Fix teardown failure handling.", createdAt: "2026-09-03T00:00:00.000Z",
      } } },
      config: adapterConfig, authToken: "mock-token", runId: "run-1", onLog: vi.fn().mockResolvedValue(undefined),
    } as unknown as AdapterExecutionContext;

    const result = await execute(ctx);
    expect(withdrawPaperclipInteraction).toHaveBeenCalledWith(
      "issue-141", "terra-plan-1", expect.stringContaining("PR rejection"), "mock-token", "run-1",
    );
    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledTimes(1);
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toBeUndefined();
    expect(sessionCodec.decode(result.sessionParams!)?.planReviewOutcome).toBe("superseded_pr_rejection");
  });

  it("does not withdraw a new plan card when the same PR rejection was already delivered", async () => {
    const deliveredFeedback = {
      version: 1 as const, kind: "code_review_rejection" as const,
      deliveryId: "native-review:luna-reject-1:abc123", issueId: "issue-141",
      reviewInteractionId: "luna-reject-1", reviewStage: "luna" as const,
      prUrl: session.currentPrUrl!, headSha: "abc123", reason: "Fix teardown failure handling.",
      createdAt: "2026-09-03T00:00:00.000Z",
    };
    const ctx = {
      agent: { id: "jules-1", companyId: "c-1", name: "Jules", adapterType: "jules", adapterConfig },
      runtime: { sessionParams: sessionCodec.encode({
        ...session, phase: "RUNNING" as const, currentPrHeadSha: "abc123",
        workerFeedbackDeliveryId: deliveredFeedback.deliveryId,
        pendingInteraction: {
          type: "plan_native_review" as const, protocolVersion: 2 as const,
          julesActivityId: "replacement-plan-activity", paperclipInteractionId: "replacement-luna-plan-1",
          question: "Replacement plan", planRevisionId: "revision-2", planRevisionNumber: 2,
          planDocumentId: "document-2", reviewerAgentId: "luna-1", stage: "luna" as const,
          createdAt: "2026-09-06T01:25:00.000Z",
        },
      }) },
      context: { task: { id: "issue-141", title: "Review" }, payload: { workerFeedback: deliveredFeedback } },
      config: adapterConfig, authToken: "mock-token", runId: "run-2", onLog: vi.fn().mockResolvedValue(undefined),
    } as unknown as AdapterExecutionContext;

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(withdrawPaperclipInteraction).not.toHaveBeenCalled();
    expect(JulesClient.prototype.sendMessage).not.toHaveBeenCalled();
    expect(sessionCodec.decode(result.sessionParams!)?.pendingInteraction).toMatchObject({
      paperclipInteractionId: "replacement-luna-plan-1",
    });
  });

  it("accepts Paperclip's nested paperclipWake payload shape", async () => {
    const ctx = {
      agent: { id: "jules-1", companyId: "c-1", name: "Jules", adapterType: "jules", adapterConfig },
      runtime: { sessionParams: sessionCodec.encode(session) },
      context: {
        task: { id: "issue-141", title: "Cap SandboxDispatcher poolCache growth" },
        paperclipWake: {
          payload: {
            workerFeedback: {
              version: 1, kind: "code_review_rejection", deliveryId: "delivery-nested",
              issueId: "issue-141", reviewInteractionId: "interaction-review-2", reviewStage: "terra",
              prUrl: session.currentPrUrl, headSha: "abc123", reason: "Fix the null branch.",
              createdAt: "2026-09-03T00:00:00.000Z",
            },
          },
        },
      },
      config: adapterConfig,
      authToken: "mock-token",
      onLog: vi.fn().mockResolvedValue(undefined),
    } as unknown as AdapterExecutionContext;
    await execute(ctx);
    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith("session-141", expect.objectContaining({
      prompt: expect.stringContaining("Fix the null branch."),
    }));
  });

  it("recovers a native rejection when Paperclip auto-continues Jules without wake payload", async () => {
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "native-rejection-1",
      kind: "request_item_verdicts",
      status: "answered",
      idempotencyKey: "pr-review:v12:issue-141:https://github.com/Pilleo/mazewall/pull/400:abc123:luna",
      result: { items: [{ id: "pull_request", verdict: "reject", reason: "Fix teardown failure handling." }] },
    }]);
    const ctx = {
      agent: { id: "jules-1", companyId: "c-1", name: "Jules", adapterType: "jules", adapterConfig },
      runtime: { sessionParams: sessionCodec.encode({ ...session, phase: "COMPLETED" as const }) },
      context: { task: { id: "issue-141", title: "Review" } },
      config: adapterConfig,
      onLog: vi.fn().mockResolvedValue(undefined),
    } as unknown as AdapterExecutionContext;
    await execute(ctx);
    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith("session-141", expect.objectContaining({
      prompt: expect.stringContaining("Fix teardown failure handling."),
    }));
  });

  it("recovers the exact persisted PR head when GitHub is temporarily unavailable", async () => {
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "native-rejection-1", kind: "request_item_verdicts", status: "answered",
      idempotencyKey: "pr-review:v13:issue-141:https://github.com/Pilleo/mazewall/pull/400:abc123:luna",
      result: { items: [{ id: "pull_request", verdict: "reject", reason: "Use the issue-scoped cancellation endpoint." }] },
    }]);
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ id: "session-141", state: "COMPLETED" } as never);
    const { getPullRequestDetails } = await import("../src/server/ci-status.js");
    vi.mocked(getPullRequestDetails).mockRejectedValueOnce(new Error("GitHub temporarily unavailable"));

    await execute({
      agent: { id: "jules-1", companyId: "c-1", name: "Jules", adapterType: "jules", adapterConfig },
      runtime: { sessionParams: sessionCodec.encode({ ...session, phase: "COMPLETED" as const, currentPrHeadSha: "abc123" }) },
      context: { task: { id: "issue-141", title: "Review" } }, config: adapterConfig,
      authToken: "mock-token", onLog: vi.fn().mockResolvedValue(undefined),
    } as unknown as AdapterExecutionContext);

    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith("session-141", expect.objectContaining({
      prompt: expect.stringContaining("issue-scoped cancellation endpoint"),
    }));
  });

  it("recovers a rejection from the Jules-owned handle when Paperclip drops wake payload and GitHub has no head", async () => {
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "native-rejection-legacy", kind: "request_item_verdicts", status: "answered",
      idempotencyKey: "pr-review:v13:issue-141:https://github.com/Pilleo/mazewall/pull/400:abc123:luna",
      result: { items: [{ id: "pull_request", verdict: "reject", reason: "Restore the canonical cancellation test." }] },
    }]);
    vi.mocked(readJulesSessionHandleState).mockResolvedValue({
      sessionId: "session-141", prUrl: session.currentPrUrl, headSha: "abc123",
    });
    const { getPullRequestDetails } = await import("../src/server/ci-status.js");
    vi.mocked(getPullRequestDetails).mockResolvedValue({ merged: false, ciStatus: "success", state: "OPEN" });

    await execute({
      agent: { id: "jules-1", companyId: "c-1", name: "Jules", adapterType: "jules", adapterConfig },
      runtime: { sessionParams: sessionCodec.encode({ ...session, phase: "COMPLETED" as const, currentPrHeadSha: undefined }) },
      // This mirrors Paperclip's real direct-wake projection: only task routing survives.
      context: { task: { id: "issue-141", title: "Review" }, paperclipWake: { issueId: "issue-141" } },
      config: adapterConfig, authToken: "mock-token", onLog: vi.fn().mockResolvedValue(undefined),
    } as unknown as AdapterExecutionContext);

    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith("session-141", expect.objectContaining({
      prompt: expect.stringContaining("canonical cancellation test"),
    }));
  });

  it("prefers a complete same-session handle over a stale legacy PR pointer", async () => {
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "native-rejection-migrated", kind: "request_item_verdicts", status: "answered",
      idempotencyKey: "pr-review:v13:issue-141:https://github.com/Pilleo/paperclip-adapters/pull/5:head-5:luna",
      result: { items: [{ id: "pull_request", verdict: "reject", reason: "Use the migrated immutable identity." }] },
    }]);
    vi.mocked(readJulesSessionHandleState).mockResolvedValue({
      sessionId: "session-141", prUrl: "https://github.com/Pilleo/paperclip-adapters/pull/5", headSha: "head-5",
    });
    const { getPullRequestDetails } = await import("../src/server/ci-status.js");
    vi.mocked(getPullRequestDetails).mockResolvedValue({ merged: false, ciStatus: "success", state: "OPEN" });

    await execute({
      agent: { id: "jules-1", companyId: "c-1", name: "Jules", adapterType: "jules", adapterConfig },
      runtime: { sessionParams: sessionCodec.encode({ ...session, phase: "COMPLETED" as const, currentPrHeadSha: undefined, currentPrUrl: "https://github.com/example/repo/pull/1" as never }) },
      context: { task: { id: "issue-141", title: "Review" } }, config: adapterConfig,
      authToken: "mock-token", onLog: vi.fn().mockResolvedValue(undefined),
    } as unknown as AdapterExecutionContext);

    expect(JulesClient.prototype.sendMessage).toHaveBeenCalledWith("session-141", expect.objectContaining({
      prompt: expect.stringContaining("migrated immutable identity"),
    }));
  });

  it("supersedes a stale plan card when recovering a lost rejection wake", async () => {
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "native-rejection-1", kind: "request_item_verdicts", status: "answered",
      idempotencyKey: "pr-review:v13:issue-141:https://github.com/Pilleo/mazewall/pull/400:abc123:luna",
      result: { items: [{ id: "pull_request", verdict: "reject", reason: "Restore the removed test." }] },
    }]);
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({ id: "session-141", state: "COMPLETED" } as never);
    vi.mocked(withdrawPaperclipInteraction).mockResolvedValue(undefined);
    await execute({
      agent: { id: "jules-1", companyId: "c-1", name: "Jules", adapterType: "jules", adapterConfig },
      runtime: { sessionParams: sessionCodec.encode({
        ...session, phase: "COMPLETED" as const, currentPrHeadSha: "abc123",
        pendingInteraction: {
          type: "plan_native_review" as const, protocolVersion: 2 as const,
          julesActivityId: "plan-activity", paperclipInteractionId: "terra-plan-1", question: "Plan",
          planRevisionId: "revision-1", planRevisionNumber: 1, planDocumentId: "document-1",
          reviewerAgentId: "terra-1", stage: "terra" as const, createdAt: "2026-09-03T00:00:00.000Z",
        },
      }) },
      context: { task: { id: "issue-141", title: "Review" } }, config: adapterConfig,
      authToken: "mock-token", runId: "run-1", onLog: vi.fn().mockResolvedValue(undefined),
    } as unknown as AdapterExecutionContext);
    expect(withdrawPaperclipInteraction).toHaveBeenCalledWith(
      "issue-141", "terra-plan-1", expect.stringContaining("PR rejection"), "mock-token", "run-1",
    );
  });

  it("does not relay a rejection belonging to an older PR head", async () => {
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "old-head-rejection",
      kind: "request_item_verdicts",
      status: "answered",
      idempotencyKey: "pr-review:v13:issue-141:https://github.com/Pilleo/mazewall/pull/400:old-head:luna",
      result: { items: [{ id: "pull_request", verdict: "reject", reason: "Old head only." }] },
    }]);
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-141", state: "COMPLETED", url: "https://jules.example/session-141",
    });

    const result = await execute({
      agent: { id: "jules-1", companyId: "c-1", name: "Jules", adapterType: "jules", adapterConfig },
      runtime: { sessionParams: sessionCodec.encode({ ...session, phase: "COMPLETED" as const }) },
      context: { task: { id: "issue-141", title: "Review" } },
      config: adapterConfig,
      authToken: "mock-token",
      onLog: vi.fn().mockResolvedValue(undefined),
    } as unknown as AdapterExecutionContext);

    expect(result.exitCode).toBe(0);
    expect(JulesClient.prototype.sendMessage).not.toHaveBeenCalled();
  });
});
