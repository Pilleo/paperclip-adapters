import { describe, it, expect, vi } from "vitest";
import { evaluateSessionStartup, isInteractionWake } from "../src/server/session-lifecycle.js";
import { evaluateSessionWatchdog } from "../src/server/watchdog.js";
import { evaluateSessionFailure } from "../src/server/failure-recovery.js";
import { extractResolvedInteraction, formatClarifyingQuestionCard } from "../src/server/interaction-relay.js";
import { JulesClient } from "../src/server/jules-client.js";
import { asPaperclipId, asJulesSessionId, asJulesActivityId } from "../src/server/brands.js";
import { JulesAdapterSessionV1, JulesAdapterSessionV1Schema } from "../src/server/session.js";
import { extractFeedbackAnswer } from "../src/server/interaction-engine.js";
import { redactTelemetry } from "../src/server/telemetry.js";
import { getPullRequestDetails } from "../src/server/ci-status.js";

describe("Parametrized Adapter Logic Matrix", () => {
  const baseConfig = {
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
    julesState: "IN_PROGRESS",
    sessionId: "sess-1",
    julesSessionId: asJulesSessionId("sess-1"),
    attempt: 1,
    failedSessions: [],
    createdAt: new Date(Date.now() - 3600000).toISOString()
  };

  describe.each([
    { context: { interactionResponse: "yes" }, expected: true, desc: "interactionResponse string" },
    { context: { providerInteractionStatus: "accepted" }, expected: true, desc: "providerInteractionStatus" },
    { context: { planReviewInteraction: { id: "p1", status: "accepted" } }, expected: true, desc: "planReviewInteraction" },
    { context: { workspaceRefreshReason: "accepted_plan_confirmation" }, expected: true, desc: "accepted_plan_confirmation reason" },
    { context: { wakeSource: "interaction_response" }, expected: true, desc: "interaction_response wakeSource" },
    { context: { wakeReason: "interaction_resolved" }, expected: true, desc: "interaction_resolved wakeReason" },
    { context: { wakeSource: "interval" }, expected: false, desc: "interval heartbeat" },
    { context: { wakeSource: "status_change", previousStatus: "backlog" }, expected: false, desc: "status_change without interaction" },
  ])("isInteractionWake parametrized ($desc)", ({ context, expected }) => {
    it(`returns ${expected}`, () => {
      expect(isInteractionWake(context)).toBe(expected);
    });
  });

  describe.each([
    {
      desc: "Standard interval heartbeat with active session",
      rawContext: { wakeSource: "interval" },
      decoded: sampleSession,
      stored: null,
      canonical: null,
      expectedAction: "RESUME_EXISTING",
      expectedFresh: false
    },
    {
      desc: "Sticky backlog snapshot on standard assignment",
      rawContext: { wakeSource: "assignment", contextSnapshot: { previousStatus: "backlog" }, previousStatus: "backlog" },
      decoded: sampleSession,
      stored: null,
      canonical: null,
      expectedAction: "RESUME_EXISTING",
      expectedFresh: false
    },
    {
      desc: "Genuine drag-and-drop status_change from backlog",
      rawContext: { wakeSource: "status_change", previousStatus: "backlog" },
      decoded: sampleSession,
      stored: null,
      canonical: null,
      expectedAction: "START_FRESH",
      expectedFresh: true
    },
    {
      desc: "Genuine drag-and-drop status_change from done (reopen)",
      rawContext: { wakeSource: "status_change", previousStatus: "done" },
      decoded: sampleSession,
      stored: null,
      canonical: null,
      expectedAction: "START_FRESH",
      expectedFresh: true
    },
    {
      desc: "Interaction response with plan approval",
      rawContext: { planReviewInteraction: { id: "p1", status: "accepted" }, previousStatus: "backlog" },
      decoded: sampleSession,
      stored: null,
      canonical: null,
      expectedAction: "RELAY_INTERACTION",
      expectedFresh: false
    },
    {
      desc: "No active session in memory, restored from stored recovery record",
      rawContext: { wakeSource: "interval" },
      decoded: null,
      stored: sampleSession,
      canonical: null,
      expectedAction: "RESUME_EXISTING",
      expectedFresh: false
    },
    {
      desc: "No decoded or stored session, recovered from canonical paperclip session ID",
      rawContext: { wakeSource: "interval" },
      decoded: null,
      stored: null,
      canonical: "canonical-555",
      expectedAction: "RESUME_EXISTING",
      expectedFresh: false
    },
    {
      desc: "Initial issue assignment with no prior session",
      rawContext: { wakeSource: "assignment" },
      decoded: null,
      stored: null,
      canonical: null,
      expectedAction: "START_FRESH",
      expectedFresh: false
    }
  ])("evaluateSessionStartup parametrized ($desc)", ({ rawContext, decoded, stored, canonical, expectedAction, expectedFresh }) => {
    it(`decides action=${expectedAction}, forceFresh=${expectedFresh}`, () => {
      const decision = evaluateSessionStartup(rawContext, decoded, stored, canonical, baseConfig);
      expect(decision.action).toBe(expectedAction);
      expect(decision.forceFreshSession).toBe(expectedFresh);
    });
  });

  describe.each([
    {
      desc: "Active recently (5m silent)",
      idleMinutes: 5,
      phase: "RUNNING",
      state: "IN_PROGRESS",
      pendingCard: false,
      lastNudgedMinutesAgo: null,
      expectedNudge: false
    },
    {
      desc: "Stalled in IN_PROGRESS (20m silent)",
      idleMinutes: 20,
      phase: "RUNNING",
      state: "IN_PROGRESS",
      pendingCard: false,
      lastNudgedMinutesAgo: null,
      expectedNudge: true
    },
    {
      desc: "Silent for 25m but waiting for human on decision card",
      idleMinutes: 25,
      phase: "WAITING_FOR_FEEDBACK",
      state: "AWAITING_USER_FEEDBACK",
      pendingCard: true,
      lastNudgedMinutesAgo: null,
      expectedNudge: false
    },
    {
      desc: "Silent for 25m but nudge cooldown active (nudged 5m ago)",
      idleMinutes: 25,
      phase: "RUNNING",
      state: "IN_PROGRESS",
      pendingCard: false,
      lastNudgedMinutesAgo: 5,
      expectedNudge: false
    },
    {
      desc: "Silent for 40m and nudge cooldown elapsed (nudged 20m ago)",
      idleMinutes: 40,
      phase: "RUNNING",
      state: "IN_PROGRESS",
      pendingCard: false,
      lastNudgedMinutesAgo: 20,
      expectedNudge: true
    },
    {
      desc: "Session in terminal completed state",
      idleMinutes: 60,
      phase: "COMPLETED",
      state: "COMPLETED",
      pendingCard: false,
      lastNudgedMinutesAgo: null,
      expectedNudge: false
    }
  ])("evaluateSessionWatchdog parametrized ($desc)", ({ idleMinutes, phase, state, pendingCard, lastNudgedMinutesAgo, expectedNudge }) => {
    it(`evaluates shouldNudge=${expectedNudge}`, () => {
      const now = Date.now();
      const lastActivity = new Date(now - idleMinutes * 60000).toISOString();
      const session: JulesAdapterSessionV1 = {
        ...sampleSession,
        phase: phase as any,
        julesState: state,
        pendingInteraction: pendingCard
          ? { type: "user_feedback", julesActivityId: asJulesActivityId("act-1"), question: "q", createdAt: lastActivity }
          : undefined,
        lastWatchdogNudgeAt: lastNudgedMinutesAgo !== null ? new Date(now - lastNudgedMinutesAgo * 60000).toISOString() : undefined,
        watchdogNudgeCount: lastNudgedMinutesAgo !== null ? 1 : 0
      };

      const result = evaluateSessionWatchdog(session, lastActivity, now);
      expect(result.shouldNudge).toBe(expectedNudge);
    });
  });

  describe.each([
    {
      desc: "First transient failure -> in-place retry 1",
      inPlaceRetriesDone: 0,
      errorText: "Jules was unable to complete the task.",
      expectedAction: "IN_PLACE_RETRY",
      expectedAttempt: 1
    },
    {
      desc: "Second transient failure -> in-place retry 2",
      inPlaceRetriesDone: 1,
      errorText: "Task error",
      expectedAction: "IN_PLACE_RETRY",
      expectedAttempt: 2
    },
    {
      desc: "Third transient failure -> in-place retries exhausted, marks blocked",
      inPlaceRetriesDone: 2,
      errorText: "Task error",
      expectedAction: "MARK_BLOCKED",
      expectedAttempt: 2
    },
    {
      desc: "Unrecoverable 401 unauthorized -> immediate block",
      inPlaceRetriesDone: 0,
      errorText: "Invalid API key unauthorized 401",
      expectedAction: "MARK_BLOCKED",
      expectedAttempt: 0
    }
  ])("evaluateSessionFailure parametrized ($desc)", ({ inPlaceRetriesDone, errorText, expectedAction, expectedAttempt }) => {
    it(`evaluates action=${expectedAction}, attempt=${expectedAttempt}`, () => {
      const session: JulesAdapterSessionV1 = {
        ...sampleSession,
        inPlaceRetryCount: inPlaceRetriesDone
      };

      const decision = evaluateSessionFailure(session, errorText);
      expect(decision.action).toBe(expectedAction);
      expect(decision.inPlaceAttempt).toBe(expectedAttempt);
    });
  });

  describe("JulesClient.listSources API", () => {
    it("fetches and parses available sources from GET /sources", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          sources: [
            { name: "sources/github/Pilleo/mazewall", displayName: "mazewall", githubRepo: { owner: "Pilleo", repo: "mazewall" } },
            { name: "sources/github/Pilleo/paperclip-jules-adapter", displayName: "paperclip-jules-adapter", githubRepo: { owner: "Pilleo", repo: "paperclip-jules-adapter" } }
          ],
          nextPageToken: "next-token-123"
        })
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;

      try {
        const client = new JulesClient("mock-api-key");
        const res = await client.listSources();
        expect(res.sources.length).toBe(2);
        expect(res.sources[0].name).toBe("sources/github/Pilleo/mazewall");
        expect(res.nextPageToken).toBe("next-token-123");
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining("/sources?pageSize=100"),
          expect.objectContaining({
            headers: expect.objectContaining({ "X-Goog-Api-Key": "mock-api-key" })
          })
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

import { formatCardPromptAndHelpText, formatCardPrompt, formatCardSummary } from "../src/server/card-prompt.js";

describe.each([
  { input: "", expectedPrompt: "Please provide input.", expectedHelp: undefined },
  { input: "Short prompt", expectedPrompt: "Short prompt", expectedHelp: undefined },
  { input: "A".repeat(600), expectedPromptLength: 490, expectedHelpLength: 110 },
  { input: "A".repeat(200) + "\n" + "B".repeat(400), expectedPromptLength: 200, expectedHelpLength: 400 },
  { input: "Sentence one. " + "Sentence two. ".repeat(40), expectedSplit: true },
])("formatCardPromptAndHelpText parametrized (%#)", ({ input, expectedPrompt, expectedHelp, expectedPromptLength, expectedHelpLength }) => {
  it("formats prompt and help text safely", () => {
    const res = formatCardPromptAndHelpText(input);
    if (expectedPrompt !== undefined) expect(res.prompt).toBe(expectedPrompt);
    if (expectedHelp !== undefined) expect(res.helpText).toBe(expectedHelp);
    if (expectedPromptLength !== undefined) expect(res.prompt.length).toBe(expectedPromptLength);
    if (expectedHelpLength !== undefined) expect(res.helpText?.length).toBe(expectedHelpLength);
  });
});

describe.each([
  { input: "", maxLen: 50, expected: "Please provide input." },
  { input: "hello world", maxLen: 50, expected: "hello world" },
  { input: "a".repeat(100), maxLen: 10, expected: "aaaaaaa..." },
])("formatCardPrompt parametrized (%#)", ({ input, maxLen, expected }) => {
  it("formats prompt", () => {
    expect(formatCardPrompt(input, maxLen)).toBe(expected);
  });
});

describe.each([
  { input: "", maxLen: 50, expected: "Question from Jules" },
  { input: "short summary", maxLen: 50, expected: "short summary" },
  { input: "s".repeat(100), maxLen: 15, expected: "ssssssssssss..." },
])("formatCardSummary parametrized (%#)", ({ input, maxLen, expected }) => {
  it("formats summary", () => {
    expect(formatCardSummary(input, maxLen)).toBe(expected);
  });
});

import { classifyFailure } from "../src/server/failure-classifier.js";
import { JulesClientError } from "../src/server/jules-client.js";

describe.each([
  { err: new JulesClientError(429, "Rate limited"), expected: "transient" },
  { err: new JulesClientError(503, "Service unavailable"), expected: "transient" },
  { err: new JulesClientError(401, "Unauthorized"), expected: "configuration" },
  { err: new JulesClientError(403, "Forbidden"), expected: "configuration" },
  { err: new JulesClientError(400, "Bad request"), expected: "task" },
  { err: new JulesClientError(422, "Unprocessable"), expected: "task" },
  { err: new Error("network timeout"), expected: "transient" },
  { err: new Error("fetch failed"), expected: "transient" },
  { err: new Error("invalid api key"), expected: "configuration" },
  { err: new Error("forbidden access"), expected: "configuration" },
  { err: "some string error", expected: "unknown" },
])("classifyFailure parametrized (%#)", ({ err, expected }) => {
  it("classifies correctly", () => {
    expect(classifyFailure(err)).toBe(expected);
  });
});

describe("getPullRequestDetails REST fallback", () => {
  it("parses merged PRs via GitHub REST fallback", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/pulls/123")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ state: "closed", merged: true, head: { sha: "abc1234" } })
        } as any;
      }
      return { ok: false, status: 404 } as any;
    });

    try {
      const details = await getPullRequestDetails("https://github.com/Pilleo/paperclip-jules-adapter/pull/123");
      expect(details.merged).toBe(true);
      expect(details.state).toBe("MERGED");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("parses open PRs with check runs via REST fallback", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/pulls/123")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ state: "open", merged: false, head: { sha: "abc1234" } })
        } as any;
      }
      if (url.includes("/commits/abc1234/check-runs")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            check_runs: [
              { name: "Build", status: "completed", conclusion: "success" }
            ]
          })
        } as any;
      }
      return { ok: false, status: 404 } as any;
    });

    try {
      const details = await getPullRequestDetails("https://github.com/Pilleo/paperclip-jules-adapter/pull/123");
      expect(details.merged).toBe(false);
      expect(details.ciStatus).toBe("success");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

import { CtxContextSchema } from "../src/server/context-schemas.js";

describe("CtxContextSchema validation", () => {
  it("fails when neither task nor paperclipIssue is present", () => {
    const res = CtxContextSchema.safeParse({});
    expect(res.success).toBe(false);
  });

  it("succeeds when paperclipIssue is present", () => {
    const res = CtxContextSchema.safeParse({ paperclipIssue: { id: "issue-1", title: "My Issue" } });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.task.id).toBe("issue-1");
    }
  });
});

describe("PR Merge Conflict and Telemetry Coverage", () => {
  it("redacts sensitive keys in telemetry", () => {
    const data = {
      apiKey: "secret-123",
      authorization: "Bearer 123",
      nested: { token: "tok-456", normal: "ok" },
      array: [{ prompt: "hello" }]
    };
    const redacted: any = redactTelemetry(data);
    expect(redacted.apiKey).toBe("[REDACTED]");
    expect(redacted.authorization).toBe("[REDACTED]");
    expect(redacted.nested.token).toBe("[REDACTED]");
    expect(redacted.nested.normal).toBe("ok");
    expect(redacted.array[0].prompt).toBe("[REDACTED]");
  });

  it("handles string redactions and basic types", () => {
    expect(redactTelemetry(123)).toBe(123);
    expect(redactTelemetry("normal string")).toBe("normal string");
  });
});

describe("extractFeedbackAnswer edge cases", () => {
  it("returns null for non-object results", () => {
    expect(extractFeedbackAnswer(null)).toBeNull();
    expect(extractFeedbackAnswer(undefined)).toBeNull();
    expect(extractFeedbackAnswer("hello")).toBeNull();
  });

  it("extracts otherText cleanly", () => {
    expect(extractFeedbackAnswer({ answers: [{ otherText: "  clean answer  " }] })).toBe("clean answer");
  });

  it("extracts optionId excluding placeholders", () => {
    expect(extractFeedbackAnswer({ answers: [{ optionId: "reply" }] })).toBeNull();
    expect(extractFeedbackAnswer({ answers: [{ optionId: "response" }] })).toBeNull();
    expect(extractFeedbackAnswer({ answers: [{ optionId: "custom_choice" }] })).toBe("custom_choice");
  });
});

describe("formatClarifyingQuestionCard", () => {
  it("formats title and trims question text", () => {
    const res = formatClarifyingQuestionCard("   Should I use TypeScript?   ");
    expect(res.title).toBe("Clarification Needed from Jules");
    expect(res.questionText).toBe("Should I use TypeScript?");
  });
});

describe("evaluateSessionWatchdog timestamp edge cases", () => {
  it("handles missing baseline timestamps gracefully", () => {
    const s: any = { phase: "RUNNING", julesState: "IN_PROGRESS" };
    const res = evaluateSessionWatchdog(s, null);
    expect(res.shouldNudge).toBe(false);
    expect(res.reason).toContain("No baseline timestamp");
  });

  it("handles invalid date strings gracefully", () => {
    const s: any = { phase: "RUNNING", julesState: "IN_PROGRESS", createdAt: "invalid-date" };
    const res = evaluateSessionWatchdog(s, null);
    expect(res.shouldNudge).toBe(false);
    expect(res.reason).toContain("Invalid baseline timestamp");
  });
});

describe("JulesAdapterSessionV1Schema RETRY_SCHEDULED edge cases", () => {
  it("validates RETRY_SCHEDULED sessions with matching or omitted sessionIds", () => {
    const validRetry = {
      version: 1,
      paperclipIssueId: "issue-1",
      promptHash: "hash123",
      repository: "Pilleo/mazewall",
      source: "sources/github/Pilleo/mazewall",
      baseBranch: "master",
      phase: "RETRY_SCHEDULED",
      attempt: 1,
      failedSessions: [],
      createdAt: new Date().toISOString()
    };
    expect(JulesAdapterSessionV1Schema.safeParse(validRetry).success).toBe(true);

    const invalidRetry = {
      ...validRetry,
      sessionId: "s1",
      julesSessionId: "s2"
    };
    expect(JulesAdapterSessionV1Schema.safeParse(invalidRetry).success).toBe(false);
  });
});

import {
  activityComment,
  extractQuestionText,
  feedbackAnswer,
  formatActivityForLog,
  interactionPlanRevisionId,
  latestAgentMessage,
  latestPlan,
  planMarkdown,
  rejectionReason,
} from "../src/server/activity-formatter.js";

describe("activity-formatter edge cases", () => {
  it("formats activity comments for user messages and failures", () => {
    expect(activityComment({ id: "1", userMessaged: { userMessage: "hello" } })).toContain("Message sent to Jules");
    expect(activityComment({ id: "2", sessionFailed: { reason: "err" } })).toContain("Jules session failed");
    expect(activityComment({ id: "3" })).toBeNull();
  });

  it("extracts latest agent message and question text", () => {
    const act = { id: "1", agentMessaged: { agentMessage: "Need help" } };
    expect(latestAgentMessage([act])?.id).toBe("1");
    expect(extractQuestionText(act)).toBe("Need help");
    expect(extractQuestionText(null)).toContain("Jules is waiting for feedback");
  });

  it("extracts latest plan and markdown steps", () => {
    const planAct = { id: "p1", planGenerated: { plan: { steps: [{ index: 0, title: "Step 1", description: "Desc" }] } } };
    expect(latestPlan([planAct])?.id).toBe("p1");
    expect(planMarkdown(planAct)).toContain("Step 1");
    expect(planMarkdown(null)).toContain("Open the Jules session");
  });

  it("extracts feedback answers and rejection reasons", () => {
    expect(feedbackAnswer({ answers: [{ otherText: "ok" }] })).toBe("ok");
    expect(feedbackAnswer(null)).toBeNull();
    expect(rejectionReason({ reason: "bad plan" })).toBe("bad plan");
    expect(rejectionReason({ answers: [{ otherText: "no" }] })).toBe("no");
    expect(rejectionReason(null)).toBeNull();
  });

  it("extracts plan revision IDs from interactions", () => {
    expect(interactionPlanRevisionId(null)).toBeNull();
    expect(interactionPlanRevisionId({ target: { type: "issue_document", key: "plan", revisionId: "rev-1" } } as any)).toBe("rev-1");
  });

  it("formats activities for logging across various activity types", () => {
    const gitAct: any = { id: "g1", createTime: new Date().toISOString(), artifacts: [{ changeSet: { gitPatch: { unidiffPatch: "diff" } } }] };
    expect(formatActivityForLog(gitAct)).toContain("Changeset patch applied");

    const planAct: any = { id: "p1", createTime: new Date().toISOString(), planGenerated: { plan: { steps: [{ index: 0, title: "T1" }] } } };
    expect(formatActivityForLog(planAct)).toContain("Generated Plan");

    const progAct: any = { id: "pr1", createTime: new Date().toISOString(), progressUpdated: { title: "Building" } };
    expect(formatActivityForLog(progAct)).toContain("Progress: Building");

    const msgAct: any = { id: "m1", createTime: new Date().toISOString(), agentMessaged: { agentMessage: "Thinking" } };
    expect(formatActivityForLog(msgAct)).toContain("Agent: Thinking");

    const usrAct: any = { id: "u1", createTime: new Date().toISOString(), userMessaged: { userMessage: "Hi" } };
    expect(formatActivityForLog(usrAct)).toContain("User input: Hi");

    const bashAct: any = { id: "b1", createTime: new Date().toISOString(), bashCodeExecution: { command: "ls", output: "file1" } };
    expect(formatActivityForLog(bashAct)).toContain("$ ls");

    const csAct: any = { id: "c1", createTime: new Date().toISOString(), changeSet: "patch details" };
    expect(formatActivityForLog(csAct)).toContain("Changeset applied");

    const compAct: any = { id: "done1", createTime: new Date().toISOString(), sessionCompleted: {} };
    expect(formatActivityForLog(compAct)).toContain("Session completed successfully");

    const failAct: any = { id: "f1", createTime: new Date().toISOString(), sessionFailed: { reason: "timeout" } };
    expect(formatActivityForLog(failAct)).toContain("Session failed: timeout");

    const descAct: any = { id: "d1", createTime: new Date().toISOString(), description: "custom desc" };
    expect(formatActivityForLog(descAct)).toContain("custom desc");

    const genericAct: any = { id: "gen1", createTime: new Date().toISOString() };
    expect(formatActivityForLog(genericAct)).toContain("Activity: gen1");
  });
});
