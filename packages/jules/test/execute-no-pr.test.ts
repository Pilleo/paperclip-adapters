import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/execute";
import { JulesClient } from "../src/server/jules-client";
import { sessionCodec } from "../src/server/session";
import {
  createNoPrCompletionInteraction,
  clearJulesSessionMonitor,
  getPaperclipInteraction,
  listPaperclipInteractions,
  moveIssueToBlocked,
  moveIssueToDone,
  PaperclipClientError,
} from "../src/server/paperclip-client.js";
import { deleteStoredSession, saveStoredSession } from "../src/server/session-store";

vi.mock("../src/server/jules-client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/jules-client")>();
  const MockedJulesClient = vi.fn();
  MockedJulesClient.prototype.getSession = vi.fn();
  MockedJulesClient.prototype.createSession = vi.fn();
  MockedJulesClient.prototype.getActivities = vi.fn().mockResolvedValue({ activities: [] });
  return { ...mod, JulesClient: MockedJulesClient };
});

vi.mock("../src/server/paperclip-client.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/server/paperclip-client.js")>();
  return {
    ...mod,
    createNoPrCompletionInteraction: vi.fn(),
    clearJulesSessionMonitor: vi.fn(),
    getPaperclipInteraction: vi.fn(),
    listPaperclipInteractions: vi.fn().mockResolvedValue([]),
    moveIssueToBlocked: vi.fn(),
    moveIssueToDone: vi.fn(),
    moveIssueToReview: vi.fn(),
  };
});

vi.mock("../src/server/session-store", () => ({
  loadStoredSession: vi.fn().mockResolvedValue(null),
  saveStoredSession: vi.fn(),
  deleteStoredSession: vi.fn(),
}));

describe("Jules completion without a PR", () => {
  const baseSession = {
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
    attempt: 1,
    failedSessions: [],
    createdAt: "2026-08-07T00:00:00.000Z",
  };

  const baseContext = {
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Jules",
      adapterType: "jules",
      adapterConfig: {
        source: "sources/github/example/repository",
        repository: "example/repository",
        baseBranch: "main",
      },
    },
    runtime: {
      sessionId: "session-1",
      sessionParams: sessionCodec.encode(baseSession as never),
      sessionDisplayId: "session-1",
      taskKey: "issue-1",
    },
    config: { env: { JULES_API_KEY: 'test-key' } },
    context: { task: { id: "issue-1", title: "Ping", description: "Do not change files" } },
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
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-1",
      name: "sessions/session-1",
      state: "COMPLETED",
      url: "https://jules.google.com/session/session-1",
    } as never);
    // clearAllMocks retains mock implementations. Reset the provider activity
    // stream so a preceding plan-gate test cannot turn this no-PR fixture into
    // a real plan-card request.
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] } as never);
    vi.mocked(createNoPrCompletionInteraction).mockResolvedValue({ id: "interaction-1", status: "pending" });
    vi.mocked(clearJulesSessionMonitor).mockResolvedValue();
    vi.mocked(getPaperclipInteraction).mockResolvedValue({ id: "interaction-1", status: "pending" } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([]);
    vi.mocked(moveIssueToBlocked).mockResolvedValue();
    vi.mocked(moveIssueToDone).mockResolvedValue();
    vi.mocked(saveStoredSession).mockResolvedValue();
    vi.mocked(deleteStoredSession).mockResolvedValue();
  });

  it("creates one confirmation, blocks explicitly, and persists its identity", async () => {
    const first = await execute(baseContext);
    const second = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams: first.sessionParams! },
      runId: "run-2",
    });

    expect(createNoPrCompletionInteraction).toHaveBeenCalledTimes(1);
    expect(createNoPrCompletionInteraction).toHaveBeenCalledWith(
      "issue-1",
      "session-1",
      "https://jules.google.com/session/session-1",
      "jwt-token",
      "run-1",
    );
    expect(moveIssueToBlocked).toHaveBeenCalledTimes(2);
    expect(first.question).toBeUndefined();
    expect(first.resultJson).toMatchObject({ issueStatus: "blocked", interactionId: "interaction-1" });
    expect(second.clearSession).toBe(false);
    expect(sessionCodec.decode(second.sessionParams!)?.pendingInteraction).toMatchObject({
      type: "completion_confirmation",
      paperclipInteractionId: "interaction-1",
    });
  });

  it("marks the issue done and clears state when confirmation is accepted", async () => {
    const sessionParams = sessionCodec.encode({
      ...baseSession,
      phase: "COMPLETED",
      pendingInteraction: {
        type: "completion_confirmation",
        paperclipInteractionId: "interaction-1",
        question: "Complete?",
        createdAt: "2026-08-07T00:00:00.000Z",
      },
    } as never);

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams },
      context: {
        ...baseContext.context,
        interactionId: "interaction-1",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      },
    });

    expect(deleteStoredSession).toHaveBeenCalledOnce();
    expect(moveIssueToDone).toHaveBeenCalledWith(
      "issue-1",
      "session-1",
      "jwt-token",
      "run-1",
      expect.stringContaining("completed without a PR"),
    );
    expect(result.clearSession).toBe(true);
    expect(result.resultJson?.issueStatus).toBe("done");
    expect(JulesClient.prototype.getSession).not.toHaveBeenCalled();
  });

  it("clears the terminal session but leaves the issue blocked when rejected", async () => {
    const sessionParams = sessionCodec.encode({
      ...baseSession,
      phase: "COMPLETED",
      pendingInteraction: {
        type: "completion_confirmation",
        paperclipInteractionId: "interaction-1",
        question: "Complete?",
        createdAt: "2026-08-07T00:00:00.000Z",
      },
    } as never);

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams },
      context: {
        ...baseContext.context,
        interactionId: "interaction-1",
        interactionKind: "request_confirmation",
        interactionStatus: "rejected",
      },
    });

    expect(deleteStoredSession).toHaveBeenCalledOnce();
    expect(moveIssueToDone).not.toHaveBeenCalled();
    expect(JulesClient.prototype.createSession).not.toHaveBeenCalled();
    expect(result.clearSession).toBe(true);
    expect(result.resultJson?.issueStatus).toBe("blocked");
  });

  it("consumes a rejected completion card when Paperclip wakes Jules without its resolved-card envelope", async () => {
    const sessionParams = sessionCodec.encode({
      ...baseSession,
      phase: "COMPLETED",
      pendingInteraction: {
        type: "completion_confirmation",
        paperclipInteractionId: "interaction-1",
        question: "Complete?",
        createdAt: "2026-08-07T00:00:00.000Z",
      },
    } as never);
    vi.mocked(getPaperclipInteraction).mockResolvedValue({ id: "interaction-1", status: "rejected" } as never);

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams },
      // Continuation recovery currently omits interactionId/status even when
      // the native confirmation has already been rejected.
      context: baseContext.context,
    });

    expect(getPaperclipInteraction).toHaveBeenCalledWith("issue-1", "interaction-1", "jwt-token", "run-1");
    expect(deleteStoredSession).toHaveBeenCalledOnce();
    expect(moveIssueToBlocked).not.toHaveBeenCalled();
    expect(moveIssueToDone).not.toHaveBeenCalled();
    expect(result.clearSession).toBe(true);
    expect(result.resultJson?.issueStatus).toBe("blocked");
  });

  it("clears a terminal session when an older rejected plan gate obscures its rejected no-PR card", async () => {
    const sessionParams = sessionCodec.encode({
      ...baseSession,
      phase: "WAITING_FOR_PLAN_APPROVAL",
      planApprovedAt: "2026-08-07T00:01:00.000Z",
      planApprovedActivityId: "old-plan-activity",
      pendingInteraction: {
        type: "plan_native_review",
        protocolVersion: 2,
        julesActivityId: "old-plan-activity",
        paperclipInteractionId: "old-plan-card",
        question: "Old plan",
        planDocumentId: "plan-doc-1",
        planRevisionId: "plan-revision-1",
        planRevisionNumber: 1,
        reviewerAgentId: "reviewer-1",
        stage: "luna",
        reviewerChildIssueId: "plan-review-child-1",
        createdAt: "2026-08-07T00:00:00.000Z",
      },
    } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({
      activities: [{
        id: "old-plan-activity",
        createTime: "2026-08-07T00:00:00.000Z",
        planGenerated: { plan: { steps: ["old step"] } },
      }],
    } as never);
    vi.mocked(listPaperclipInteractions).mockResolvedValue([{
      id: "rejected-no-pr-card",
      kind: "request_confirmation",
      status: "rejected",
      idempotencyKey: "jules:no-pr-completion:issue-1:session-1",
      result: { outcome: "rejected" },
    }] as never);

    const result = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams },
    });

    expect(deleteStoredSession).toHaveBeenCalledOnce();
    expect(getPaperclipInteraction).not.toHaveBeenCalledWith(
      "plan-review-child-1", "old-plan-card", "jwt-token", "run-1",
    );
    expect(result.clearSession).toBe(true);
    expect(result.resultJson?.issueStatus).toBe("blocked");
  });

  it("does not clear state for a mismatched or missing completion interaction", async () => {
    const missing = await execute({
      ...baseContext,
      context: {
        ...baseContext.context,
        interactionId: "interaction-1",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      },
    });
    expect(missing.exitCode).toBe(0);
    expect(missing.summary).toContain("stale");

    const sessionParams = sessionCodec.encode({
      ...baseSession,
      pendingInteraction: {
        type: "completion_confirmation",
        paperclipInteractionId: "interaction-expected",
        question: "Complete?",
        createdAt: "2026-08-07T00:00:00.000Z",
      },
    } as never);
    const mismatched = await execute({
      ...baseContext,
      runtime: { ...baseContext.runtime, sessionParams },
      context: {
        ...baseContext.context,
        interactionId: "interaction-other",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      },
    });

    expect(mismatched.exitCode).toBe(0);
    expect(mismatched.summary).toContain("stale");
    expect(deleteStoredSession).not.toHaveBeenCalled();
    expect(mismatched.clearSession).toBe(false);
  });

  it("keeps session state and schedules retry when Paperclip interaction creation fails transiently", async () => {
    vi.mocked(createNoPrCompletionInteraction).mockRejectedValue(
      new PaperclipClientError(503, "Paperclip unavailable"),
    );

    const result = await execute(baseContext);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("paperclip_completion_interaction_failed");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.retryNotBefore).toBeTruthy();
    expect(result.clearSession).toBe(false);
    expect(sessionCodec.decode(result.sessionParams!)?.sessionId).toBe("session-1");
  });
});
