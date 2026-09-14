import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/execute";
import { JulesClient } from "../src/server/jules-client";
import { sessionCodec } from "../src/server/session";
import {
  clearJulesSessionMonitor,
  hasFutureJulesSessionMonitor,
  listPaperclipInteractions,
  moveIssueToReview,
  scheduleJulesSessionMonitor,
} from "../src/server/paperclip-client";
import { PaperclipClientError } from "../src/server/paperclip-client";

vi.mock("../src/server/jules-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/jules-client")>();
  const Mocked = vi.fn();
  Mocked.prototype.getSession = vi.fn();
  Mocked.prototype.getActivities = vi.fn().mockResolvedValue({ activities: [] });
  Mocked.prototype.createSession = vi.fn();
  Mocked.prototype.listSessions = vi.fn().mockResolvedValue({ sessions: [] });
  Mocked.prototype.approvePlan = vi.fn();
  Mocked.prototype.sendMessage = vi.fn();
  return { ...mod, JulesClient: Mocked };
});

vi.mock("../src/server/paperclip-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/paperclip-client")>();
  return {
    ...mod,
    listPaperclipInteractions: vi.fn().mockResolvedValue([]),
    listIssueComments: vi.fn().mockResolvedValue([]),
    getPaperclipInteraction: vi.fn(),
    createNoPrCompletionInteraction: vi.fn().mockResolvedValue({ id: "no-pr-card", status: "pending" }),
    moveIssueToBlocked: vi.fn().mockResolvedValue(undefined),
    createJulesPlanApprovalInteraction: vi.fn().mockResolvedValue({
      id: "plan-approval-card",
      planRevision: {
        documentId: "plan-document-1",
        revisionId: "plan-revision-1",
        revisionNumber: 1,
      },
    }),
    clearJulesSessionMonitor: vi.fn().mockResolvedValue(undefined),
    moveIssueToReview: vi.fn().mockResolvedValue(undefined),
    scheduleJulesSessionMonitor: vi.fn().mockResolvedValue(),
    hasFutureJulesSessionMonitor: vi.fn().mockResolvedValue(false),
  };
});

describe("heartbeat yield vs session deadline", () => {
  const session = {
    version: 1 as const,
    paperclipIssueId: "issue-yield",
    promptHash: "hash",
    promptHashVersion: 2,
    repository: "owner/repo",
    source: "sources/github/owner/repo",
    baseBranch: "main",
    phase: "RUNNING" as const,
    sessionId: "session-live",
    julesSessionId: "session-live",
    attempt: 1,
    failedSessions: [],
    createdAt: new Date().toISOString(),
  };

  const ctx = (): AdapterExecutionContext =>
    ({
      agent: {
        id: "jules-1",
        companyId: "c-1",
        name: "Jules",
        adapterType: "jules",
        adapterConfig: {
          repository: "owner/repo",
          source: "sources/github/owner/repo",
          baseBranch: "main",
          pollCadenceSeconds: 30,
        },
      },
      config: { env: { JULES_API_KEY: "test-key" } },
      context: { task: { id: "issue-yield", title: "Ping" } },
      runtime: {
        sessionId: "session-live",
        sessionParams: sessionCodec.encode(session as never),
        sessionDisplayId: "session-live",
      },
      runId: "run-yield",
      authToken: "token",
      onLog: vi.fn(),
    }) as AdapterExecutionContext;

  beforeAll(() => {
    process.env.JULES_API_KEY = "test-key";
  });
  afterAll(() => {
    delete process.env.JULES_API_KEY;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listPaperclipInteractions).mockResolvedValue([]);
  });

  it("yields after one IN_PROGRESS poll and keeps the Jules session id", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-live",
      state: "IN_PROGRESS",
    } as never);

    const before = Date.now();
    const result = await execute(ctx());

    expect(JulesClient.prototype.createSession).not.toHaveBeenCalled();
    expect(JulesClient.prototype.getSession).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
    expect(result.clearSession).toBe(false);
    expect(result.sessionDisplayId).toBe("session-live");
    expect(sessionCodec.decode(result.sessionParams!)?.julesSessionId).toBe("session-live");
    expect(result.summary).toBeUndefined();
    const retryAt = new Date(result.retryNotBefore!).getTime();
    expect(retryAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(retryAt).toBeLessThan(before + 90_000);
  });

  it("rechecks a requested plan revision instead of waiting the normal coding cadence", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-live",
      state: "IN_PROGRESS",
    } as never);

    const before = Date.now();
    const result = await execute({
      ...ctx(),
      agent: {
        ...ctx().agent,
        adapterConfig: { ...ctx().agent.adapterConfig, pollCadenceSeconds: 900 },
      },
      runtime: {
        ...ctx().runtime,
        sessionParams: sessionCodec.encode({
          ...session,
          planReviewOutcome: "revision_requested",
        } as never),
      },
    } as AdapterExecutionContext);

    const retryAt = new Date(result.retryNotBefore!).getTime();
    expect(retryAt).toBeLessThan(before + 90_000);
  });

  it("scans bounded terminal activity history in one heartbeat before yielding", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-live",
      state: "COMPLETED",
    } as never);
    vi.mocked(JulesClient.prototype.getActivities)
      .mockResolvedValueOnce({
        activities: [{ id: "old-message", createTime: "2026-09-09T10:00:00.000Z", agentMessaged: { agentMessage: "Historical" } }],
        nextPageToken: "page-2",
      } as never)
      .mockResolvedValueOnce({ activities: [] } as never);

    const result = await execute(ctx());
    const decoded = sessionCodec.decode(result.sessionParams!);

    expect(JulesClient.prototype.getActivities).toHaveBeenNthCalledWith(1, "session-live", undefined, 100);
    expect(JulesClient.prototype.getActivities).toHaveBeenNthCalledWith(2, "session-live", "page-2", 100);
    expect(decoded?.terminalActivityScan).toMatchObject({
      sessionId: "session-live",
      latestAgentMessage: { id: "old-message" },
      complete: true,
    });
    expect(result.clearSession).toBe(false);
  });

  it("defers an advisory review wake to an already scheduled monitor", async () => {
    vi.mocked(hasFutureJulesSessionMonitor).mockResolvedValueOnce(true);

    const result = await execute({
      ...ctx(),
      context: {
        task: { id: "issue-yield", title: "Ping" },
        wakeSource: "on_demand",
        wakeReason: "Native PR review needs work for [MAZ-985]. Jules will reconcile the bound structured verdict.",
      },
    } as AdapterExecutionContext);

    expect(hasFutureJulesSessionMonitor).toHaveBeenCalledWith(
      "issue-yield", "session-live", "token", "run-yield",
    );
    expect(JulesClient.prototype.getSession).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(result.clearSession).toBe(false);
    expect(result.resultJson).toMatchObject({ skipped: true, reason: "future_jules_monitor" });
  });

  it("does not defer a terminal plan-cycle recovery behind an advisory monitor", async () => {
    vi.mocked(hasFutureJulesSessionMonitor).mockResolvedValueOnce(true);
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-live",
      state: "COMPLETED",
      source: "sources/github/owner/repo",
    } as never);
    vi.mocked(JulesClient.prototype.createSession).mockResolvedValue({
      id: "recovery-session",
      name: "sessions/recovery-session",
    } as never);

    await execute({
      ...ctx(),
      context: {
        task: { id: "issue-yield", title: "Ping" },
        wakeSource: "on_demand",
        wakeReason: "A stale monitor requested recovery.",
      },
      runtime: {
        ...ctx().runtime,
        sessionParams: sessionCodec.encode({
          ...session,
          phase: "RETRY_SCHEDULED",
          currentPrUrl: "https://github.com/owner/repo/pull/7",
          currentPrHeadSha: "head-7",
          currentPrHeadRef: "jules-existing-pr-branch",
          prRemediation: {
            originalSessionId: "session-live",
            prUrl: "https://github.com/owner/repo/pull/7",
            headSha: "head-7",
            headRefName: "jules-existing-pr-branch",
            startedAt: "2026-09-14T02:00:00.000Z",
            reason: "terminal_plan_revision_unavailable",
          },
        } as never),
      },
    } as AdapterExecutionContext);

    expect(hasFutureJulesSessionMonitor).not.toHaveBeenCalled();
    expect(JulesClient.prototype.createSession).toHaveBeenCalledWith(expect.objectContaining({
      sourceContext: expect.objectContaining({
        githubRepoContext: { startingBranch: "jules-existing-pr-branch" },
      }),
    }));
  });

  it("polls an explicit provider-plan synchronization wake despite a future monitor", async () => {
    vi.mocked(hasFutureJulesSessionMonitor).mockResolvedValueOnce(true);
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-live",
      state: "IN_PROGRESS",
    } as never);

    await execute({
      ...ctx(),
      context: {
        task: { id: "issue-yield", title: "Ping" },
        wakeSource: "on_demand",
        wakeReason: "synchronize_provider_plan_ready",
      },
    } as AdapterExecutionContext);

    expect(hasFutureJulesSessionMonitor).not.toHaveBeenCalled();
    expect(JulesClient.prototype.getSession).toHaveBeenCalledWith("session-live");
  });

  it("rescans terminal provider activity after an explicit plan-ready wake", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-live",
      state: "COMPLETED",
    } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValueOnce({
      activities: [{
        id: "revised-plan", createTime: "2026-09-14T00:00:00.000Z",
        planGenerated: { plan: { steps: [{ index: 0, title: "Revised plan", description: "Addresses review feedback" }] } },
      }],
    } as never);

    await execute({
      ...ctx(),
      context: {
        task: { id: "issue-yield", title: "Ping" },
        wakeSource: "on_demand",
        wakeReason: "synchronize_provider_plan_ready",
      },
      runtime: {
        sessionId: "session-live",
        sessionDisplayId: "session-live",
        sessionParams: sessionCodec.encode({
          ...session,
          terminalActivityScan: {
            sessionId: "session-live",
            complete: true,
            latestPlan: { id: "obsolete-plan" },
          },
        } as never),
      },
    } as AdapterExecutionContext);

    expect(JulesClient.prototype.getActivities).toHaveBeenCalledWith("session-live", undefined, 100);
  });

  it("clears a stale Jules monitor while a native plan card owns the next decision", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-live",
      state: "AWAITING_PLAN_APPROVAL",
    } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "plan-card-1",
      kind: "request_item_verdicts",
      status: "pending",
    }] as never);

    await execute({
      ...ctx(),
      runtime: {
        sessionId: "session-live",
        sessionParams: sessionCodec.encode({
          ...session,
          phase: "WAITING_FOR_PLAN_APPROVAL",
          pendingInteraction: {
            type: "plan_native_review", protocolVersion: 2,
            julesActivityId: "plan-activity", question: "Plan", paperclipInteractionId: "plan-card-1",
            planDocumentId: "plan-document-1", planRevisionId: "plan-revision-1", planRevisionNumber: 1,
            reviewerAgentId: "luna-1", stage: "luna", reviewerChildIssueId: "plan-review-child-1", createdAt: new Date().toISOString(),
          },
        } as never),
      },
    } as AdapterExecutionContext);

    expect(scheduleJulesSessionMonitor).not.toHaveBeenCalled();
    expect(clearJulesSessionMonitor).toHaveBeenCalledWith("issue-yield", "token", "run-yield");
  });

  it("keeps the reviewer-owned plan wait healthy when parent monitor cleanup is forbidden", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-live",
      state: "AWAITING_PLAN_APPROVAL",
    } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "plan-card-1",
      kind: "request_item_verdicts",
      status: "pending",
    }] as never);
    vi.mocked(clearJulesSessionMonitor).mockRejectedValueOnce(
      new PaperclipClientError(403, "Only the assignee agent or a board user can manage issue monitors"),
    );

    const result = await execute({
      ...ctx(),
      runtime: {
        sessionId: "session-live",
        sessionParams: sessionCodec.encode({
          ...session,
          phase: "WAITING_FOR_PLAN_APPROVAL",
          pendingInteraction: {
            type: "plan_native_review", protocolVersion: 2,
            julesActivityId: "plan-activity", question: "Plan", paperclipInteractionId: "plan-card-1",
            planDocumentId: "plan-document-1", planRevisionId: "plan-revision-1", planRevisionNumber: 1,
            reviewerAgentId: "luna-1", stage: "luna", reviewerChildIssueId: "plan-review-child-1", createdAt: new Date().toISOString(),
          },
        } as never),
      },
    } as AdapterExecutionContext);

    expect(result.exitCode).toBe(0);
    expect(result.resultJson).toMatchObject({
      pending: true,
      continuation: "native_plan_review",
      monitorAuthorizationFallback: true,
    });
  });

  it("drops a stale completed PR checkpoint when the remote session is awaiting plan approval", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-live",
      state: "AWAITING_PLAN_APPROVAL",
      // Jules retains historical outputs after a rejected PR. A nonterminal
      // provider state is authoritative; this old output must not recreate a
      // PR handoff after reconciliation has discarded its stale checkpoint.
      rawOutputs: [{ pullRequest: { url: "https://github.com/owner/repo/pull/1" } }],
    } as never);
    const result = await execute({
      ...ctx(),
      runtime: {
        sessionId: "session-live",
        sessionParams: sessionCodec.encode({
          ...session, phase: "COMPLETED", julesState: "COMPLETED",
          currentPrUrl: "https://github.com/owner/repo/pull/1",
          currentPrHeadSha: "deadbeef", prRegisteredOnBoard: true,
        } as never),
      },
    });

    const decoded = sessionCodec.decode(result.sessionParams!);
    expect(decoded?.julesState).toBe("AWAITING_PLAN_APPROVAL");
    expect(decoded?.currentPrUrl).toBeUndefined();
    expect(decoded?.currentPrHeadSha).toBeUndefined();
    expect(decoded?.prRegisteredOnBoard).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeUndefined();
    expect(moveIssueToReview).not.toHaveBeenCalled();
    expect(clearJulesSessionMonitor).not.toHaveBeenCalled();
  });

  it("keeps a persisted Jules session resumable when monitor scheduling is unavailable", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-live",
      state: "IN_PROGRESS",
    } as never);
    vi.mocked(scheduleJulesSessionMonitor).mockRejectedValueOnce(new Error("Paperclip monitor unavailable"));
    const onLog = vi.fn();

    const result = await execute({ ...ctx(), onLog });

    expect(result.exitCode).toBe(1);
    expect(result.clearSession).toBe(false);
    expect(result.errorCode).toBe("paperclip_monitor_schedule_failed");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(sessionCodec.decode(result.sessionParams!)?.julesSessionId).toBe("session-live");
    expect(onLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining("Could not schedule the next Paperclip monitor"),
    );
  });

  it("does not relay an accepted historical plan card when its immutable pointer is missing", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-live",
      state: "AWAITING_PLAN_APPROVAL",
    } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([
      {
        id: "plan-card-accepted",
        kind: "request_confirmation",
        status: "accepted",
        result: { planRevisionId: "rev-1" },
      },
    ] as never);

    const result = await execute(ctx());

    expect(JulesClient.prototype.approvePlan).not.toHaveBeenCalled();
    expect(JulesClient.prototype.createSession).not.toHaveBeenCalled();
    expect(result.clearSession).toBe(false);
    expect(result.sessionDisplayId).toBe("session-live");
    const decoded = sessionCodec.decode(result.sessionParams!);
    expect(decoded?.planApprovedAt).toBeUndefined();
  });

  it("keeps polling a live Jules session older than sessionDeadlineMinutes and does not create a replacement", async () => {
    const aged = {
      ...session,
      createdAt: new Date(Date.now() - 2881 * 60 * 1000).toISOString(),
    };
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-live",
      state: "IN_PROGRESS",
    } as never);

    const result = await execute({
      ...ctx(),
      runtime: {
        sessionId: "session-live",
        sessionParams: sessionCodec.encode(aged as never),
        sessionDisplayId: "session-live",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.clearSession).toBe(false);
    expect(result.sessionDisplayId).toBe("session-live");
    expect(JulesClient.prototype.createSession).not.toHaveBeenCalled();
    expect(JulesClient.prototype.getSession).toHaveBeenCalledTimes(1);
  });
});
