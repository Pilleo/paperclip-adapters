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

  it("recovers a newer v3 Terra intent instead of replaying a Luna child", () => {
    const identity = { version: 3 as const, companyId: "co", parentIssueId: "task-123", sessionId: "sess-1", activityId: "activity",
      documentId: "doc", revisionId: "revision", revisionNumber: 1, stage: "luna" as const,
      reviewerAgentId: "luna", bootstrapAgentId: "orch", julesAgentId: "jules" };
    const replayed = { ...sampleSession, childPlanReview: { identity, childId: "luna-child" } };
    const recovered = { ...sampleSession, childPlanReview: { identity: { ...identity, stage: "terra" as const, reviewerAgentId: "terra" } } };
    expect(mergeDurableSessionCheckpoints(replayed, recovered).childPlanReview).toEqual(recovered.childPlanReview);
  });

  it("does not resurrect a v3 child after its provider approval was checkpointed", () => {
    const identity = { version: 3 as const, companyId: "co", parentIssueId: "task-123", sessionId: "sess-1", activityId: "activity",
      documentId: "doc", revisionId: "revision", revisionNumber: 1, stage: "terra" as const,
      reviewerAgentId: "terra", bootstrapAgentId: "orch", julesAgentId: "jules" };
    const replayed = { ...sampleSession, childPlanReview: { identity, childId: "terra-child" } };
    const recovered = { ...sampleSession, planApprovedActivityId: "activity" };
    expect(mergeDurableSessionCheckpoints(replayed, recovered).childPlanReview).toBeUndefined();
  });

  it("restores the newer Terra card and confirmed journal after a cancelled Luna-to-Terra transfer", () => {
    const luna = {
      type: "plan_native_review" as const, protocolVersion: 2 as const,
      julesActivityId: asJulesActivityId("plan-activity"), question: "Plan",
      paperclipInteractionId: "luna-card", planDocumentId: "plan-document",
      planRevisionId: "revision-1", planRevisionNumber: 1,
      reviewerAgentId: "luna-agent", stage: "luna" as const,
      createdAt: "2026-09-26T00:00:00.000Z",
    };
    const terra = { ...luna, paperclipInteractionId: "terra-card", reviewerAgentId: "terra-agent", stage: "terra" as const };
    const recovered: JulesAdapterSessionV1 = {
      ...sampleSession, pendingInteraction: terra,
      lifecycleEffectJournal: { version: 1, effects: [{
        effectId: "card:terra:revision-1", kind: "create_card",
        attempt: { kind: "confirmed", receipt: "terra-card" },
      }] },
    };
    const replayed: JulesAdapterSessionV1 = { ...sampleSession, pendingInteraction: luna };
    const merged = mergeDurableSessionCheckpoints(replayed, recovered);
    expect(merged.julesSessionId).toBe(sampleSession.julesSessionId);
    expect(merged.pendingInteraction).toMatchObject({ stage: "terra", paperclipInteractionId: "terra-card" });
    expect(merged.lifecycleEffectJournal).toEqual(recovered.lifecycleEffectJournal);
  });

  it("never downgrades a durable confirmed approval to a replayed started effect", () => {
    const replayed: JulesAdapterSessionV1 = { ...sampleSession, lifecycleEffectJournal: { version: 1, effects: [
      { effectId: "approve:sess-1:rev-1", kind: "approve_plan",
        attempt: { kind: "started", startedAt: "2026-09-27T00:00:00.000Z", attempts: 1 } },
    ] } };
    const recovered: JulesAdapterSessionV1 = { ...sampleSession, lifecycleEffectJournal: { version: 1, effects: [
      { effectId: "approve:sess-1:rev-1", kind: "approve_plan", attempt: { kind: "confirmed", receipt: "provider:approval-1" } },
    ] } };
    expect(mergeDurableSessionCheckpoints(replayed, recovered).lifecycleEffectJournal?.effects)
      .toEqual(recovered.lifecycleEffectJournal?.effects);
    expect(mergeDurableSessionCheckpoints(recovered, replayed).lifecycleEffectJournal?.effects)
      .toEqual(recovered.lifecycleEffectJournal?.effects);
  });

  it("fails closed when two confirmed approval receipts disagree", () => {
    const left: JulesAdapterSessionV1 = { ...sampleSession, lifecycleEffectJournal: { version: 1, effects: [
      { effectId: "approve:sess-1:rev-1", kind: "approve_plan", attempt: { kind: "confirmed", receipt: "provider:approval-1" } },
    ] } };
    const right: JulesAdapterSessionV1 = { ...sampleSession, lifecycleEffectJournal: { version: 1, effects: [
      { effectId: "approve:sess-1:rev-1", kind: "approve_plan", attempt: { kind: "confirmed", receipt: "provider:approval-2" } },
    ] } };
    expect(() => mergeDurableSessionCheckpoints(left, right)).toThrow(/conflict/i);
  });

  it("restores the approved plan identity and outcome together with its confirmed durable effect", () => {
    const replayed: JulesAdapterSessionV1 = { ...sampleSession,
      planApprovedAt: "2026-09-20T00:00:00.000Z", planApprovedActivityId: "old-plan",
      planReviewOutcome: "revision_requested" };
    const recovered: JulesAdapterSessionV1 = { ...sampleSession,
      planApprovedAt: "2026-09-27T00:00:00.000Z", planApprovedActivityId: "new-plan",
      planReviewOutcome: "approved", lifecycleEffectJournal: { version: 1, effects: [{
        effectId: "approve:sess-1:revision-new", kind: "approve_plan",
        attempt: { kind: "confirmed", receipt: "provider:approval-new" },
      }] } };
    const merged = mergeDurableSessionCheckpoints(replayed, recovered);
    expect({ at: merged.planApprovedAt, activity: merged.planApprovedActivityId, outcome: merged.planReviewOutcome })
      .toEqual({ at: recovered.planApprovedAt, activity: "new-plan", outcome: "approved" });
  });

  it("holds conflicting confirmed approvals for different generated plans", () => {
    const old: JulesAdapterSessionV1 = { ...sampleSession, planApprovedActivityId: "old-plan", planReviewOutcome: "approved",
      lifecycleEffectJournal: { version: 1, effects: [{ effectId: "approve:sess-1:revision-old", kind: "approve_plan",
        attempt: { kind: "confirmed", receipt: "provider:approval-old" } }] } };
    const next: JulesAdapterSessionV1 = { ...sampleSession, planApprovedActivityId: "new-plan", planReviewOutcome: "approved",
      lifecycleEffectJournal: { version: 1, effects: [{ effectId: "approve:sess-1:revision-new", kind: "approve_plan",
        attempt: { kind: "confirmed", receipt: "provider:approval-new" } }] } };
    expect(() => mergeDurableSessionCheckpoints(old, next)).toThrow(/approval.*conflict/i);
  });

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

  it("resumes the exact durable provider session after Paperclip restores a failed native run", () => {
    const identity = { version: 3 as const, companyId: "co", parentIssueId: "task-123", sessionId: "sess-1",
      activityId: "plan-1", documentId: "doc-1", revisionId: "rev-1", revisionNumber: 1,
      stage: "terra" as const, reviewerAgentId: "gemini", bootstrapAgentId: "orch", julesAgentId: "jules" };
    const replayed = { ...sampleSession, phase: "WAITING_FOR_PLAN_APPROVAL" as const,
      childPlanReview: { identity, childId: "gemini-child" } };
    const stored = { ...sampleSession, phase: "WAITING_FOR_PLAN_APPROVAL" as const,
      planApprovedAt: "2026-09-27T20:15:00Z", planApprovedActivityId: "plan-1", planReviewOutcome: "approved" as const,
      lifecycleEffectJournal: { version: 1 as const, effects: [{ effectId: "approve:sess-1:rev-1", kind: "approve_plan" as const,
        attempt: { kind: "confirmed" as const, receipt: "provider:approval-1" } }] } };
    const recovery = { forceFreshSession: true, source: "execution.reconciled", wakeReason: "issue_recovery_action_restored",
      recoveryActionId: "recovery-1", previousRunId: "failed-run", issueId: "task-123" };
    const decision = evaluateSessionStartup(recovery, replayed, stored, "sess-1", config);
    expect(decision.action).toBe("RESUME_EXISTING");
    expect(decision.forceFreshSession).toBe(false);
    expect(decision.session?.julesSessionId).toBe(sampleSession.julesSessionId);
    expect(decision.session?.childPlanReview).toBeUndefined();
    expect(decision.session?.lifecycleEffectJournal?.effects[0]?.attempt).toMatchObject({ kind: "confirmed" });
  });

  it("fails closed if native recovery's runtime and disk checkpoints identify different Jules sessions", () => {
    const recovery = { forceFreshSession: true, source: "execution.reconciled", wakeReason: "issue_recovery_action_restored",
      recoveryActionId: "recovery-1", previousRunId: "failed-run", issueId: "task-123" };
    expect(() => evaluateSessionStartup(recovery, { ...sampleSession, julesSessionId: asJulesSessionId("other") },
      sampleSession, null, config)).toThrow(/session.*conflict|checkpoint.*conflict/i);
  });

  it("never turns an incomplete native recovery envelope into a fresh cloud Jules session", () => {
    const partial = { forceFreshSession: true, wakeReason: "issue_recovery_action_restored",
      recoveryActionId: "recovery-1", previousRunId: "failed-run", issueId: "task-123" };
    expect(() => evaluateSessionStartup(partial, null, sampleSession, null, config))
      .toThrow(/recovery.*incomplete|checkpoint.*conflict/i);
    expect(() => evaluateSessionStartup({ ...partial, source: "execution.reconciled", previousRunId: undefined },
      null, sampleSession, null, config)).toThrow(/recovery.*incomplete|checkpoint.*conflict/i);
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
