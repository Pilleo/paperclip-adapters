import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/execute.js";
import { JulesClient } from "../src/server/jules-client.js";
import { sessionCodec } from "../src/server/session.js";
import { getPullRequestDetails, getPullRequestPatch, listPullRequestChangedFiles } from "../src/server/ci-status.js";
import {
  createJulesAgentAdjudicationInteraction,
  createJulesQuestionReviewInteraction,
  activateInternalReviewIssue,
  createJulesQuestionAdjudication,
  moveIssueToReview,
  scheduleJulesSessionMonitor,
} from "../src/server/paperclip-client.js";

vi.mock("../src/server/ci-status.js", () => ({
  getPullRequestDetails: vi.fn(),
  getPullRequestCiStatus: vi.fn().mockResolvedValue("success"),
  listPullRequestChangedFiles: vi.fn(),
  getPullRequestPatch: vi.fn(),
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
    createIssueComment: vi.fn().mockResolvedValue(undefined),
    createJulesAgentAdjudicationInteraction: vi.fn().mockResolvedValue({ id: "visible-question-1", status: "pending" }),
    createJulesQuestionReviewInteraction: vi.fn().mockResolvedValue({ id: "question-form-1", status: "pending" }),
    activateInternalReviewIssue: vi.fn().mockResolvedValue(undefined),
    createJulesQuestionAdjudication: vi.fn().mockResolvedValue({ id: "question-review-1", status: "todo" }),
    listIssueComments: vi.fn().mockResolvedValue([]),
    listPaperclipInteractions: vi.fn().mockResolvedValue([]),
    scheduleJulesSessionMonitor: vi.fn().mockResolvedValue(undefined),
    moveIssueToBlocked: vi.fn(),
    moveIssueToInProgress: vi.fn(),
    moveIssueToReview: vi.fn(),
  };
});

const WORK_PACKAGE = `---
title: "Cap SandboxDispatcher poolCache growth"
component: "enforcer"
priority: high
target_files: ["enforcer/src/main/kotlin/io/mazewall/enforcer/SandboxDispatcher.kt"]
target_symbols: ["SandboxDispatcher#getOrCreate"]
---

**Context:** poolCache is unbounded.
**Needed:** Bound the cache at 32 entries with LRU eviction and add tests.
`;

describe("E2E host-plan scope conformity on Jules PRs", () => {
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
    attempt: 1,
    failedSessions: [],
    createdAt: "2026-08-30T00:00:00.000Z",
  };

  const adapterConfig = {
    env: { JULES_API_KEY: "test-key" },
    repository: "Pilleo/mazewall",
    baseBranch: "master",
    ciPolicy: "skip",
    questionReviewerAgentId: "00000000-0000-4000-8000-000000000834",
  };

  function ctx(runtimeSession = session): AdapterExecutionContext {
    return {
      agent: {
        id: "jules-1",
        companyId: "c-1",
        name: "Jules",
        adapterType: "jules",
        adapterConfig,
      },
      runtime: { sessionParams: sessionCodec.encode(runtimeSession) },
      context: {
        task: {
          id: "issue-141",
          title: "Cap SandboxDispatcher poolCache growth",
          description: WORK_PACKAGE,
        },
      },
      config: adapterConfig,
      onLog: vi.fn().mockResolvedValue(undefined),
    } as unknown as AdapterExecutionContext;
  }

  beforeAll(() => {
    process.env.JULES_API_KEY = "test-key";
  });
  afterAll(() => {
    delete process.env.JULES_API_KEY;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks preserves queued one-shot provider responses; reset them
    // so a terminal scope-drift test cannot leak an old question into the next
    // lifecycle scenario.
    vi.mocked(JulesClient.prototype.getSession).mockReset();
    vi.mocked(JulesClient.prototype.getActivities).mockReset();
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      id: "session-141",
      state: "COMPLETED",
      url: "https://jules.example/session-141",
      rawOutputs: [{ pullRequest: { url: "https://github.com/Pilleo/mazewall/pull/400" } }],
    });
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({ activities: [] });
    vi.mocked(JulesClient.prototype.sendMessage).mockResolvedValue(null);
    vi.mocked(getPullRequestDetails).mockResolvedValue({
      state: "OPEN",
      merged: false,
      ciStatus: "success",
      mergeableStatus: "mergeable",
    });
  });

  it("hands scope drift to the normal PR review pipeline without messaging Jules", async () => {
    vi.mocked(listPullRequestChangedFiles).mockResolvedValue([
      "enforcer/src/main/kotlin/io/mazewall/enforcer/SandboxDispatcher.kt",
      "README.md",
    ]);
    vi.mocked(getPullRequestPatch).mockResolvedValue("fun getOrCreate()");

    const executionContext = ctx();
    const result = await execute(executionContext);
    expect(result.exitCode).toBe(0);
    expect(result.clearSession).toBe(false);
    expect(result.resultJson?.scopeConformant).toBe(false);
    expect(result.summary).toMatch(/created a PR/);
    expect(result.resultJson).toMatchObject({
      issueStatus: "in_review",
      scopeConformant: false,
      providerMessageSent: false,
    });
    expect(moveIssueToReview).toHaveBeenCalledWith(
      "issue-141",
      "https://github.com/Pilleo/mazewall/pull/400",
      undefined,
      "",
    );
    expect(JulesClient.prototype.sendMessage).not.toHaveBeenCalled();
    expect(executionContext.onLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining("Scope Drift Detected"),
    );
  });

  it("does not flag drift when the PR stays inside declared files and symbols", async () => {
    vi.mocked(listPullRequestChangedFiles).mockResolvedValue([
      "enforcer/src/main/kotlin/io/mazewall/enforcer/SandboxDispatcher.kt",
    ]);
    vi.mocked(getPullRequestPatch).mockResolvedValue("+ fun getOrCreate() { /* LRU */ }");

    const result = await execute(ctx());
    expect(result.resultJson?.scopeConformant).not.toBe(false);
    expect(result.summary).not.toMatch(/drifted from the host plan/);
  });

  it("keeps polling and routes a question that arrives after the drift heartbeat", async () => {
    vi.mocked(listPullRequestChangedFiles).mockResolvedValue([
      "enforcer/src/main/kotlin/io/mazewall/enforcer/SandboxDispatcher.kt",
      "README.md",
    ]);
    vi.mocked(getPullRequestPatch).mockResolvedValue("fun getOrCreate()");
    vi.mocked(JulesClient.prototype.getSession)
      .mockResolvedValueOnce({ state: "COMPLETED", rawOutputs: [{ pullRequest: { url: "https://github.com/o/r/pull/1" } }] } as never)
      .mockResolvedValueOnce({ state: "AWAITING_USER_FEEDBACK", rawOutputs: [{ pullRequest: { url: "https://github.com/o/r/pull/1" } }] } as never);
    vi.mocked(JulesClient.prototype.getActivities)
      .mockResolvedValueOnce({ activities: [] } as never)
      .mockResolvedValueOnce({
        activities: [{ id: "question-1", createTime: "2026-08-31T10:00:00.000Z", agentMessaged: { agentMessage: "Which branch should I use?" } }],
      } as never);

    const first = await execute(ctx());
    expect(first.resultJson).toMatchObject({ issueStatus: "in_review" });
    // A completed PR is handed to the normal review pipeline immediately;
    // it no longer burns a Jules monitor heartbeat while waiting for a host.
    expect(scheduleJulesSessionMonitor).toHaveBeenCalledTimes(0);

    const second = await execute(ctx(sessionCodec.decode(first.sessionParams)!));
    expect(createJulesQuestionAdjudication).toHaveBeenCalled();
    expect(scheduleJulesSessionMonitor).toHaveBeenCalledTimes(1);
    expect(second.resultJson).toMatchObject({ pending: true });
  });

  it("routes a fresh typed Jules message during an in-flight plan review before the provider state flips", async () => {
    vi.mocked(listPullRequestChangedFiles).mockResolvedValue([
      "enforcer/src/main/kotlin/io/mazewall/enforcer/SandboxDispatcher.kt",
    ]);
    vi.mocked(getPullRequestPatch).mockResolvedValue("+ fun getOrCreate() { /* LRU */ }");
    vi.mocked(JulesClient.prototype.getSession).mockResolvedValue({
      // Jules can still report IN_PROGRESS while the activity stream already
      // contains the message that needs a reviewer answer.
      state: "IN_PROGRESS",
      rawOutputs: [{ pullRequest: { url: "https://github.com/o/r/pull/1" } }],
    } as never);
    vi.mocked(JulesClient.prototype.getActivities).mockResolvedValue({
      activities: [{
        id: "question-while-reviewing",
        createTime: "2026-08-31T10:01:00.000Z",
        // Jules can publish its plan and its follow-up question in the same
        // heartbeat. The question must remain the adjudication prompt.
        planGenerated: { plan: { steps: [{ index: 0, title: "Unrelated plan text" }] } },
        agentMessaged: { agentMessage: "Please confirm the target branch." },
      }],
    } as never);

    const planReview = {
      type: "plan_agent_review" as const,
      julesActivityId: "plan-activity",
      question: "Plan contents",
      planRevisionId: "plan-revision",
      planRevisionNumber: 1,
      planDocumentId: "plan-document",
      reviewIssueId: "review-child",
      reviewerAgentId: "reviewer-1",
      stage: "vibe" as const,
      createdAt: "2026-08-31T10:00:00.000Z",
    };
    const result = await execute(ctx({ ...session, pendingInteraction: planReview }));
    const checkpoint = sessionCodec.decode(result.sessionParams!);

    expect(createJulesQuestionAdjudication).toHaveBeenCalled();
    expect(createJulesAgentAdjudicationInteraction).toHaveBeenCalledWith(
      "issue-141",
      "session-141",
      "question-while-reviewing",
      "Please confirm the target branch.",
      "00000000-0000-4000-8000-000000000834",
      undefined,
      "",
    );
    expect(checkpoint?.pendingInteraction).toMatchObject({ type: "agent_adjudication", nativeForm: true, paperclipInteractionId: "visible-question-1" });
    expect(checkpoint?.deferredPlanReview).toMatchObject({
      type: "plan_agent_review",
      reviewIssueId: "review-child",
    });
    expect(scheduleJulesSessionMonitor).toHaveBeenCalledTimes(1);
  });

  it("does not replay or send the same drift finding on a repeated heartbeat", async () => {
    vi.mocked(listPullRequestChangedFiles).mockResolvedValue([
      "enforcer/src/main/kotlin/io/mazewall/enforcer/SandboxDispatcher.kt",
      "README.md",
    ]);
    vi.mocked(getPullRequestPatch).mockResolvedValue("fun getOrCreate()");

    const first = await execute(ctx());
    const nextSession = sessionCodec.decode(first.sessionParams);
    expect(nextSession?.scopeDriftFingerprint).toBeDefined();
    vi.mocked(JulesClient.prototype.sendMessage).mockClear();

    const second = await execute(ctx(nextSession!));
    expect(JulesClient.prototype.sendMessage).not.toHaveBeenCalled();
    expect(second.summary).toBeNull();
    expect(second.resultJson).toMatchObject({ providerMessageSent: false });
  });
});
