import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/execute";
import { JulesClient } from "../src/server/jules-client";
import { sessionCodec } from "../src/server/session";
import {
  createJulesPlanApprovalInteraction,
  getPaperclipInteraction,
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
    getPaperclipInteraction: vi.fn(),
    moveIssueToBlocked: vi.fn(),
    moveIssueToInProgress: vi.fn(),
  };
});

describe("E2E Jules Plan Presentation & Interactive Resume Loop", () => {
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
    vi.mocked(moveIssueToBlocked).mockResolvedValue();
    vi.mocked(moveIssueToInProgress).mockResolvedValue();
  });

  it("creates a plan approval card and keeps issue in_progress when Jules presents a plan", async () => {
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      state: "AWAITING_PLAN_APPROVAL",
      id: "session-141",
    } as never);

    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({
      activities: [
        {
          id: "act-plan-1",
          createTime: "2026-08-30T00:01:00.000Z",
          planGenerated: {
            plan: {
              steps: [
                { index: 0, title: "Create PoolKey projection data class", description: "Mirror PolicyCompilationCache" },
                { index: 1, title: "Cap LinkedHashMap with LRU eviction", description: "Call shutdown on evicted pools" },
              ],
            },
          },
        },
      ],
    } as never);

    vi.mocked(createJulesPlanApprovalInteraction).mockResolvedValue({
      id: "plan-card-1",
      status: "pending",
      planRevision: {
        documentId: "doc-1",
        revisionId: "rev-1",
        revisionNumber: 1,
      },
    } as never);

    const result = await execute(baseContext);

    // 1. MUST NOT mark issue as blocked!
    expect(moveIssueToBlocked).not.toHaveBeenCalled();

    // 2. MUST create plan approval card with formatted markdown steps
    expect(createJulesPlanApprovalInteraction).toHaveBeenCalledWith(
      "issue-141",
      "session-141",
      "act-plan-1",
      expect.stringContaining("Create PoolKey projection data class"),
      "jwt-token",
      "run-1"
    );

    // 3. Result must preserve session with pending interaction
    const decoded = sessionCodec.decode(result.sessionParams!);
    expect(decoded?.phase).toBe("WAITING_FOR_PLAN_APPROVAL");
    expect(decoded?.pendingInteraction).toMatchObject({
      type: "plan_approval",
      paperclipInteractionId: "plan-card-1",
    });
    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("awaits plan approval");
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

  it("creates a plan approval card instead of moving to blocked when Jules finishes planning turn without PR", async () => {
    // Jules API returns state: "COMPLETED" after first planning turn without PR
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      state: "COMPLETED",
      id: "session-141",
    } as never);

    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({
      activities: [
        {
          id: "act-plan-turn-1",
          createTime: "2026-08-30T00:01:00.000Z",
          planGenerated: {
            plan: {
              steps: [
                { index: 0, title: "Design PoolKey projection", description: "Projection without Landlock paths" },
                { index: 1, title: "Implement LRU eviction in SandboxDispatcher (TBD)", description: "Cap at 32 entries" },
              ],
            },
          },
        },
      ],
    } as never);

    vi.mocked(createJulesPlanApprovalInteraction).mockResolvedValue({
      id: "plan-card-turn-1",
      status: "pending",
      planRevision: {
        documentId: "doc-1",
        revisionId: "rev-1",
        revisionNumber: 1,
      },
    } as never);

    const result = await execute(baseContext);

    // MUST NOT mark issue as blocked!
    expect(moveIssueToBlocked).not.toHaveBeenCalled();

    // MUST create plan approval interaction
    expect(createJulesPlanApprovalInteraction).toHaveBeenCalledWith(
      "issue-141",
      "session-141",
      "act-plan-turn-1",
      expect.stringContaining("Design PoolKey projection"),
      "jwt-token",
      "run-1"
    );

    const decoded = sessionCodec.decode(result.sessionParams!);
    expect(decoded?.phase).toBe("WAITING_FOR_PLAN_APPROVAL");
  });
});
