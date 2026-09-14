import { describe, it, expect } from "vitest";
import {
  evaluateSessionStartup,
  isInteractionWake,
  mergeDurableSessionCheckpoints,
  recoverPrIdentityFromWorkProduct,
  restoreBranchBoundRemediationFromHandle,
  shouldReclaimBranchBoundRecovery,
  sessionMatchesConfig,
  shouldReadIssueSessionHandle,
} from "../src/server/session-lifecycle.js";
import type { JulesSessionHandle } from "../src/server/jules-session-handle.js";
import { asJulesActivityId, asPaperclipId, asJulesSessionId } from "../src/server/brands.js";
import { JulesAdapterSessionV1 } from "../src/server/session.js";

describe("session-lifecycle", () => {
  const config = {
    repository: "Pilleo/mazewall",
    source: "sources/github/Pilleo/mazewall",
    baseBranch: "master",
    taskId: asPaperclipId("task-123")
  };

  const sampleSession: JulesAdapterSessionV1 = {
    version: 1,
    paperclipIssueId: asPaperclipId("task-123"),
    promptHash: "hash123",
    repository: "Pilleo/mazewall",
    source: "sources/github/Pilleo/mazewall",
    baseBranch: "master",
    phase: "RUNNING",
    sessionId: "sess-1",
    julesSessionId: asJulesSessionId("sess-1"),
    attempt: 1,
    failedSessions: [],
    createdAt: new Date().toISOString()
  };

  it.each([
    { description: "tokenless local trusted recovery", hasSession: false, hasCanonicalSessionId: false, hasStoredRecoverySession: false, expected: true },
    { description: "decoded session wins", hasSession: true, hasCanonicalSessionId: false, hasStoredRecoverySession: false, expected: false },
    { description: "canonical session wins", hasSession: false, hasCanonicalSessionId: true, hasStoredRecoverySession: false, expected: false },
    { description: "local recovery record wins", hasSession: false, hasCanonicalSessionId: false, hasStoredRecoverySession: true, expected: false },
  ])("issue handle lookup: $description", ({ hasSession, hasCanonicalSessionId, hasStoredRecoverySession, expected }) => {
    expect(shouldReadIssueSessionHandle({ hasSession, hasCanonicalSessionId, hasStoredRecoverySession })).toBe(expected);
  });

  it("matches session identity on repository, source, and base branch", () => {
    expect(sessionMatchesConfig(sampleSession, config)).toBe(true);
    expect(sessionMatchesConfig({ ...sampleSession, baseBranch: "dev" }, config)).toBe(false);
    expect(sessionMatchesConfig({ ...sampleSession, repository: "paperclipai/paperclip" }, config)).toBe(false);
    expect(sessionMatchesConfig(null, config)).toBe(false);
  });

  it.each([
    {
      desc: "interval + decoded session resumes",
      rawContext: { wakeSource: "interval" },
      decoded: sampleSession,
      stored: null as JulesAdapterSessionV1 | null,
      canonical: null as string | null,
      handle: null as string | null,
      action: "RESUME_EXISTING",
      sessionId: "sess-1",
    },
    {
      desc: "runtime canonical id rebuilds when params empty",
      rawContext: { wakeSource: "on_demand" },
      decoded: null,
      stored: null,
      canonical: "runtime-id",
      handle: null,
      action: "RESUME_EXISTING",
      sessionId: "runtime-id",
    },
    {
      desc: "issue handle last after disk miss",
      rawContext: { wakeSource: "on_demand" },
      decoded: null,
      stored: null,
      canonical: null,
      handle: "issue-handle-777",
      action: "RESUME_EXISTING",
      sessionId: "issue-handle-777",
    },
    {
      desc: "status_change from backlog is fresh",
      rawContext: { wakeSource: "status_change", previousStatus: "backlog" },
      decoded: sampleSession,
      stored: null,
      canonical: null,
      handle: null,
      action: "START_FRESH",
      sessionId: undefined,
    },
    {
      desc: "disk recovery when params and runtime id are empty",
      rawContext: { wakeSource: "interval" },
      decoded: null,
      stored: sampleSession,
      canonical: null,
      handle: null,
      action: "RESUME_EXISTING",
      sessionId: "sess-1",
    },
    {
      desc: "accepted plan card is a relay, not a fresh session",
      rawContext: { workspaceRefreshReason: "accepted_plan_confirmation" },
      decoded: sampleSession,
      stored: null,
      canonical: null,
      handle: null,
      action: "RELAY_INTERACTION",
      sessionId: "sess-1",
    },
  ])("startup table: $desc", ({ rawContext, decoded, stored, canonical, handle, action, sessionId }) => {
    const decision = evaluateSessionStartup(rawContext, decoded, stored, canonical, config, handle);
    expect(decision.action).toBe(action);
    expect(decision.session?.sessionId).toBe(sessionId);
  });

  it("identifies interaction wakes correctly", () => {
    expect(isInteractionWake({ interactionResponse: "yes" })).toBe(true);
    expect(isInteractionWake({ providerInteractionStatus: "accepted" })).toBe(true);
    expect(isInteractionWake({ planReviewInteraction: { id: "p1", status: "accepted" } })).toBe(true);
    expect(isInteractionWake({ workspaceRefreshReason: "accepted_plan_confirmation" })).toBe(true);
    expect(isInteractionWake({ wakeSource: "interaction_response" })).toBe(true);
    expect(isInteractionWake({ wakeReason: "user_interaction_resolved" })).toBe(true);
    expect(isInteractionWake({ wakeSource: "interval" })).toBe(false);
  });

  it("resumes existing decoded session on standard heartbeat", () => {
    const decision = evaluateSessionStartup(
      { wakeSource: "interval" },
      sampleSession,
      null,
      null,
      config
    );

    expect(decision.action).toBe("RESUME_EXISTING");
    expect(decision.forceFreshSession).toBe(false);
    expect(decision.session?.sessionId).toBe("sess-1");
  });

  it("merges newer local idempotency checkpoints into a replayed session envelope", () => {
    const stored = {
      ...sampleSession,
      scopeDriftFingerprint: "pr-1\ndrift-1",
      deliveredFeedbackActivityId: "question-1",
      supersededPlanActivityId: "plan-1",
      pendingPlanRevisionRequest: {
        interactionId: "expired-terra-card",
        planActivityId: "plan-1",
        state: "prepared",
      },
      unresolvedProviderQuestionActivityId: "question-1",
      providerContinuation: {
        deliveryId: "native-review:card-1:sha-1",
        state: "sent_awaiting_provider" as const,
        sentAt: "2026-09-06T10:00:00.000Z",
      },
    };
    const decision = evaluateSessionStartup(
      // Paperclip can refresh execution configuration while retaining the same
      // provider session. That must not erase delivery checkpoints from the
      // local recovery record and re-open an already-resolved provider prompt.
      {}, sampleSession, stored, null, { ...config, baseBranch: "release" },
    );
    expect(decision.session?.scopeDriftFingerprint).toBe("pr-1\ndrift-1");
    expect(decision.session?.deliveredFeedbackActivityId).toBe("question-1");
    expect(decision.session?.supersededPlanActivityId).toBe("plan-1");
    expect(decision.session?.pendingPlanRevisionRequest).toEqual({
      interactionId: "expired-terra-card",
      planActivityId: "plan-1",
      state: "prepared",
    });
    expect(decision.session?.unresolvedProviderQuestionActivityId).toBe("question-1");
    expect(decision.session?.providerContinuation).toEqual(stored.providerContinuation);
  });

  it("restores the complete PR identity after a configuration-refresh replay", () => {
    const replayed = {
      ...sampleSession,
      // Paperclip may replace runtime session parameters when configuration is
      // refreshed, losing data that belongs to the still-identical provider
      // session.
      currentPrUrl: undefined,
      currentPrHeadSha: undefined,
    };
    const recovered = {
      ...sampleSession,
      currentPrUrl: "https://github.com/Pilleo/paperclip-adapters/pull/8" as const,
      currentPrHeadSha: "ded4b31084904b1302fd74bd2ef70818164a3c8b",
    };

    expect(mergeDurableSessionCheckpoints(replayed, recovered)).toMatchObject({
      currentPrUrl: "https://github.com/Pilleo/paperclip-adapters/pull/8",
      currentPrHeadSha: "ded4b31084904b1302fd74bd2ef70818164a3c8b",
    });
  });

  it("restores the PR head branch with the URL and SHA", () => {
    const replayed = {
      ...sampleSession,
      currentPrUrl: undefined,
      currentPrHeadSha: undefined,
      currentPrHeadRef: undefined,
    } as JulesAdapterSessionV1;
    const recovered = {
      ...sampleSession,
      currentPrUrl: "https://github.com/Pilleo/paperclip-adapters/pull/11" as const,
      currentPrHeadSha: "ded4b31084904b1302fd74bd2ef70818164a3c8b",
      currentPrHeadRef: "jules-18036993849073318863-b259ffba",
    } as JulesAdapterSessionV1;

    expect(mergeDurableSessionCheckpoints(replayed, recovered)).toMatchObject({
      currentPrHeadRef: "jules-18036993849073318863-b259ffba",
    });
  });

  it("rehydrates a lost session handle from the primary PR work product", () => {
    const recovered = recoverPrIdentityFromWorkProduct(sampleSession, {
      url: "https://github.com/Pilleo/paperclip-adapters/pull/11",
      headSha: "ded4b31084904b1302fd74bd2ef70818164a3c8b",
      headRefName: "jules-18036993849073318863-b259ffba",
    });

    expect(recovered).toMatchObject({
      currentPrUrl: "https://github.com/Pilleo/paperclip-adapters/pull/11",
      currentPrHeadSha: "ded4b31084904b1302fd74bd2ef70818164a3c8b",
      currentPrHeadRef: "jules-18036993849073318863-b259ffba",
      prRegisteredOnBoard: true,
    });
  });

  it("rebuilds a branch-bound remediation fence from the Paperclip-owned session handle", () => {
    const handle: JulesSessionHandle = {
      sessionId: "recovery-42",
      prUrl: "https://github.com/Pilleo/paperclip-adapters/pull/11",
      headSha: "ded4b31084904b1302fd74bd2ef70818164a3c8b",
      headRefName: "jules-42-fix-ci",
      remediation: {
        originalSessionId: "terminal-41",
        recoverySessionId: "recovery-42",
        reason: "ci_failure",
      },
    };

    const restored = restoreBranchBoundRemediationFromHandle(
      {
        ...sampleSession,
        sessionId: "recovery-42",
        julesSessionId: asJulesSessionId("recovery-42"),
        planApprovedAt: "2026-09-14T00:01:00.000Z",
        planApprovedActivityId: asJulesActivityId("stale-plan"),
        planReviewOutcome: "approved",
        deliveredFeedbackActivityId: asJulesActivityId("stale-feedback"),
        deliveredFeedbackInteractionId: "stale-feedback-card",
        terminalFeedbackActivityId: asJulesActivityId("stale-terminal-feedback"),
        unresolvedProviderQuestionActivityId: asJulesActivityId("stale-unresolved-question"),
        pendingPlanRevisionRequest: {
          interactionId: "stale-native-card",
          planActivityId: asJulesActivityId("stale-plan"),
          state: "delivered",
          requestedAt: "2026-09-14T00:01:00.000Z",
        },
        pendingInteraction: {
          type: "plan_native_review",
          protocolVersion: 2,
          julesActivityId: asJulesActivityId("stale-plan"),
          paperclipInteractionId: "stale-native-card",
          question: "Stale recovery-plan card",
          planDocumentId: "doc-stale",
          planRevisionId: "revision-stale",
          planRevisionNumber: 1,
          reviewerAgentId: "reviewer-1",
          stage: "luna",
          createdAt: "2026-09-14T00:01:00.000Z",
        },
      },
      handle,
      "2026-09-14T00:00:00.000Z",
    );
    expect(restored).toMatchObject({
      currentPrUrl: "https://github.com/Pilleo/paperclip-adapters/pull/11",
      currentPrHeadSha: "ded4b31084904b1302fd74bd2ef70818164a3c8b",
      currentPrHeadRef: "jules-42-fix-ci",
      prRemediation: {
        originalSessionId: "terminal-41",
        recoverySessionId: "recovery-42",
        reason: "ci_failure",
      },
    });
    expect(restored).not.toHaveProperty("pendingInteraction");
    expect(restored).not.toHaveProperty("planApprovedAt");
    expect(restored).not.toHaveProperty("planApprovedActivityId");
    expect(restored).not.toHaveProperty("planReviewOutcome");
    expect(restored).not.toHaveProperty("deliveredFeedbackActivityId");
    expect(restored).not.toHaveProperty("deliveredFeedbackInteractionId");
    expect(restored).not.toHaveProperty("terminalFeedbackActivityId");
    expect(restored).not.toHaveProperty("unresolvedProviderQuestionActivityId");
    expect(restored).not.toHaveProperty("pendingPlanRevisionRequest");
  });

  it.each([
    ["reclaims only its own pending form", "in_review", null, `jules:agent-adjudication:task-123:sess-1:activity-1`, true],
    ["does not reclaim an ordinary review", "in_review", null, "other:interaction", false],
    ["does not steal an assigned review", "in_review", "other-agent", `jules:agent-adjudication:task-123:sess-1:activity-1`, false],
  ])("%s", (_name, status, assigneeAgentId, idempotencyKey, expected) => {
    expect(shouldReclaimBranchBoundRecovery({
      session: {
        ...sampleSession,
        sessionId: asJulesSessionId("sess-1"),
        julesSessionId: asJulesSessionId("sess-1"),
        prRemediation: {
          originalSessionId: "original-1", recoverySessionId: "sess-1", reason: "ci_failure",
          prUrl: "https://github.com/Pilleo/paperclip-adapters/pull/11",
          headSha: "a".repeat(40), headRefName: "branch", startedAt: "2026-09-14T00:00:00.000Z",
        },
      },
      issue: { status, assigneeAgentId },
      interactions: [{ status: "pending", idempotencyKey }],
    })).toBe(expected);
  });

  it("retains terminal scan progress across a configuration-refresh replay", () => {
    const replayed = { ...sampleSession, terminalActivityScan: undefined };
    const recovered = {
      ...sampleSession,
      terminalActivityScan: {
        sessionId: "sess-1",
        nextPageToken: "page-9",
        completion: { id: "completion-1", createTime: "2026-09-09T10:00:00.000Z", sessionCompleted: {} },
        latestAgentMessage: { id: "message-1", createTime: "2026-09-09T10:01:00.000Z", agentMessaged: { agentMessage: "Question" } },
        postCompletionQuestion: { id: "message-1", createTime: "2026-09-09T10:01:00.000Z", agentMessaged: { agentMessage: "Question" } },
        complete: false,
      },
    } satisfies JulesAdapterSessionV1;

    expect(mergeDurableSessionCheckpoints(replayed, recovered).terminalActivityScan).toMatchObject({
      nextPageToken: "page-9",
      postCompletionQuestion: { id: "message-1" },
      complete: false,
    });
  });

  it("relays interaction when wake is an interaction response", () => {
    const decision = evaluateSessionStartup(
      { planReviewInteraction: { id: "p1", status: "accepted" }, previousStatus: "backlog" },
      sampleSession,
      null,
      null,
      config
    );

    expect(decision.action).toBe("RELAY_INTERACTION");
    expect(decision.isInteractionResume).toBe(true);
    expect(decision.forceFreshSession).toBe(false);
    expect(decision.session?.sessionId).toBe("sess-1");
  });

  it("does NOT force fresh session on sticky backlog status unless wakeSource is status_change", () => {
    const decision = evaluateSessionStartup(
      {
        wakeSource: "assignment",
        contextSnapshot: { previousStatus: "backlog" },
        previousStatus: "backlog"
      },
      sampleSession,
      null,
      null,
      config
    );

    expect(decision.action).toBe("RESUME_EXISTING");
    expect(decision.forceFreshSession).toBe(false);
    expect(decision.session?.sessionId).toBe("sess-1");
  });

  it("forces fresh session when wakeSource is explicitly status_change from backlog/done/cancelled", () => {
    const decision = evaluateSessionStartup(
      {
        wakeSource: "status_change",
        previousStatus: "backlog"
      },
      sampleSession,
      null,
      null,
      config
    );

    expect(decision.action).toBe("START_FRESH");
    expect(decision.forceFreshSession).toBe(true);
    expect(decision.session).toBeNull();
  });

  it("restores session from stored recovery when decoded is missing", () => {
    const decision = evaluateSessionStartup(
      { wakeSource: "interval" },
      null,
      sampleSession,
      null,
      config
    );

    expect(decision.action).toBe("RESUME_EXISTING");
    expect(decision.session?.sessionId).toBe("sess-1");
  });

  it("rebuilds session identity from canonicalSessionId when decoded is missing", () => {
    const decision = evaluateSessionStartup(
      { wakeSource: "interval" },
      null,
      null,
      "canonical-999",
      config
    );

    expect(decision.action).toBe("RESUME_EXISTING");
    expect(decision.session?.sessionId).toBe("canonical-999");
    expect(decision.session?.julesSessionId).toBe("canonical-999");
  });

  it("prefers the local recovery record over the Paperclip issue handle", () => {
    const decision = evaluateSessionStartup(
      { wakeSource: "interval" },
      null,
      sampleSession,
      null,
      config,
      "issue-handle-777",
    );
    expect(decision.session?.sessionId).toBe("sess-1");
  });

  it("rebuilds session identity from the Paperclip issue handle when runtime and disk are empty", () => {
    const decision = evaluateSessionStartup(
      { wakeSource: "on_demand" },
      null,
      null,
      null,
      config,
      "issue-handle-777",
    );

    expect(decision.action).toBe("RESUME_EXISTING");
    expect(decision.forceFreshSession).toBe(false);
    expect(decision.session?.sessionId).toBe("issue-handle-777");
    expect(decision.session?.julesSessionId).toBe("issue-handle-777");
  });

  it("starts fresh when no session exists anywhere", () => {
    const decision = evaluateSessionStartup(
      { wakeSource: "assignment" },
      null,
      null,
      null,
      config
    );

    expect(decision.action).toBe("START_FRESH");
    expect(decision.forceFreshSession).toBe(false);
    expect(decision.session).toBeNull();
  });
});
