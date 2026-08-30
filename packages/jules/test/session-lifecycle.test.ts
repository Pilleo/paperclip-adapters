import { describe, it, expect } from "vitest";
import { evaluateSessionStartup, isInteractionWake, sessionMatchesConfig } from "../src/server/session-lifecycle.js";
import { asPaperclipId, asJulesSessionId } from "../src/server/brands.js";
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

  it("matches session identity on repository, source, and base branch", () => {
    expect(sessionMatchesConfig(sampleSession, config)).toBe(true);
    expect(sessionMatchesConfig({ ...sampleSession, baseBranch: "dev" }, config)).toBe(false);
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
