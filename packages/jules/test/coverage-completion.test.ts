import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { buildValidatedIssuePatch } from "../src/server/disposition.js";
import { discoverLocalGitDefaultBranch, discoverLocalGitRepository, validateConfig } from "../src/server/config.js";
import { activityComment, extractQuestionText, formatActivityForLog, latestAgentMessage, latestPlan, planMarkdown } from "../src/server/activity-formatter.js";
import { extractFeedbackAnswer, evaluateInteractionAction, determinePaperclipIssueStatus } from "../src/server/interaction-engine.js";
import type { JulesAdapterSessionV1 } from "../src/server/session.js";
import { createJulesPlanReviewChild } from "../src/server/plan-review-client.js";
import { extractResolvedInteraction } from "../src/server/interaction-relay.js";

describe("deterministic coverage paths", () => {
  it("builds every valid disposition patch and rejects an invalid review transition", () => {
    expect(buildValidatedIssuePatch("in_review").isValid).toBe(false);
    expect(buildValidatedIssuePatch("in_review", { targetStatus: "in_review", kind: "interaction_card", interactionId: "i" }).payloadPatch).toMatchObject({ reviewInteractionId: "i" });
    expect(buildValidatedIssuePatch("in_review", { targetStatus: "in_review", kind: "assigned_reviewer", reviewerAgentId: "a" }).payloadPatch).toMatchObject({ assigneeAgentId: "a" });
    expect(buildValidatedIssuePatch("in_review", { targetStatus: "in_review", kind: "assigned_user", userId: "u" }, "review").payloadPatch).toMatchObject({ assigneeUserId: "u", comment: "review" });
    expect(buildValidatedIssuePatch("in_progress").payloadPatch).toEqual({ status: "in_progress" });
    expect(buildValidatedIssuePatch("in_progress", { targetStatus: "in_progress", kind: "assigned_worker", workerAgentId: "w" }).payloadPatch).toMatchObject({ assigneeAgentId: "w" });
    for (const status of ["backlog", "todo", "blocked", "done", "cancelled"] as const) {
      expect(buildValidatedIssuePatch(status).payloadPatch.status).toBe(status);
    }
  });

  it("normalizes repository settings and discovers the local git metadata", () => {
    expect(validateConfig({ repository: "git@github.com:Acme/Tool.git", baseBranch: "main" }).repository).toBe("Acme/Tool");
    expect(validateConfig({ repository: "https://user:pass@github.com/acme/tool.git", baseBranch: "main" }).repository).toBe("acme/tool");
    expect(discoverLocalGitRepository(process.cwd())).toContain("github.com");
    expect(discoverLocalGitDefaultBranch(process.cwd())).toBeTypeOf("string");
    expect(discoverLocalGitRepository("/tmp/does-not-exist-for-coverage")).toBeUndefined();
    expect(discoverLocalGitDefaultBranch("/tmp/does-not-exist-for-coverage")).toBeUndefined();
  });

  it("formats structured activity variants and plans", () => {
    const plan = { id: "plan", createTime: "2026-08-31T00:00:00.000Z", planGenerated: { plan: { steps: [{ index: 1, title: "Test", description: "Run it" }] } } } as any;
    const question = { id: "q", createTime: "2026-08-31T00:00:00.000Z", agentMessaged: { agentMessage: "Need a decision" } } as any;
    expect(activityComment(question)).toContain("Need a decision");
    expect(activityComment({ userMessaged: { userMessage: "answer" } } as any)).toContain("answer");
    expect(activityComment({ sessionFailed: { reason: "boom" } } as any)).toContain("boom");
    expect(activityComment({ description: "progress" } as any)).toContain("progress");
    expect(activityComment(plan)).toBeNull();
    expect(latestAgentMessage([question])).toBe(question);
    expect(latestPlan([plan])).toBe(plan);
    expect(extractQuestionText(question)).toBe("Need a decision");
    expect(extractQuestionText(null)).toContain("waiting");
    expect(planMarkdown(plan)).toContain("**Test**");
    expect(formatActivityForLog(plan)).toContain("Generated Plan");
    expect(formatActivityForLog({ progressUpdated: { title: "Build", description: "done" }, createTime: "2026-08-31T00:00:00.000Z" } as any)).toContain("Progress");
    expect(formatActivityForLog(question)).toContain("Agent");
  });

  it("covers interaction reducer terminal and pending branches", () => {
    const session: JulesAdapterSessionV1 = { version: 1, paperclipIssueId: "i", promptHash: "h", repository: "o/r", source: "s", baseBranch: "main", phase: "RUNNING", julesSessionId: "s1", sessionId: "s1", attempt: 1, failedSessions: [], createdAt: new Date().toISOString() };
    expect(evaluateInteractionAction(session, "COMPLETED").type).toBe("CONFIRM_NO_PR_COMPLETION");
    expect(evaluateInteractionAction({ ...session, currentPrUrl: "https://github.com/o/r/pull/1" }, "COMPLETED").type).toBe("RESOLVE_COMPLETION_WITH_PR");
    expect(evaluateInteractionAction(session, "PAUSED").type).toBe("RESET_PAUSED_SESSION");
    expect(evaluateInteractionAction(session, "AWAITING_PLAN_APPROVAL", [{ id: "p", kind: "request_confirmation", status: "pending" }]).type).toBe("WAIT_FOR_HUMAN");
    expect(evaluateInteractionAction({ ...session, pendingInteraction: { type: "user_feedback", julesActivityId: "a", paperclipInteractionId: "p", question: "q", createdAt: new Date().toISOString() } }, "AWAITING_USER_FEEDBACK", [{ id: "p", kind: "ask_user_questions", status: "answered", result: { answers: [{ otherText: "yes" }] } }]).type).toBe("RELAY_FEEDBACK");
    expect(determinePaperclipIssueStatus("RUNNING" as any).status).toBe("in_progress");
    expect(extractFeedbackAnswer({ answers: [{ otherText: "  answer  " }] })).toBe("answer");
  });

  it("creates and reuses an ACP plan-review child idempotently", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (init?.method !== "POST" && calls.length === 1) {
        return new Response(JSON.stringify({ issues: [] }), { status: 200 });
      }
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ id: "review-child-1", status: "todo" }), { status: 201 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;
    try {
      const created = await createJulesPlanReviewChild("issue-1", "reviewer-1", "vibe", "Plan", "revision-1", "token", "run", "company-1");
      expect(created.id).toBe("review-child-1");
      expect(calls.some((call) => call.includes("POST") && call.includes("/children"))).toBe(true);
      expect(calls.some((call) => call.includes("PATCH") && call.includes("review-child-1"))).toBe(true);

      const fingerprint = createHash("sha256").update("issue-1:revision-1:vibe").digest("hex").slice(0, 24);
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ issues: [{ id: "existing-review", parentId: "issue-1", description: `<!-- jules-plan-review:${fingerprint} -->` }] }), { status: 200 })) as typeof fetch;
      const existing = await createJulesPlanReviewChild("issue-1", "reviewer-1", "vibe", "Plan", "revision-1", "token", "run", "company-1");
      expect(existing.id).toBe("existing-review");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("resolves wake context precedence and structured interaction status", () => {
    const session = { phase: "RUNNING", pendingInteraction: undefined } as unknown as JulesAdapterSessionV1;
    expect(extractResolvedInteraction({ paperclipWake: { interactionId: "wake", interactionKind: "ask_user_questions", interactionStatus: "answered" } }, session)).toMatchObject({ interactionId: "wake", isAnswered: true });
    expect(extractResolvedInteraction({ interactionResponse: { answer: "Use main" } }, session)).toMatchObject({ answer: "Use main", status: "answered", isAnswered: true });
    expect(extractResolvedInteraction({ planReviewInteraction: { id: "plan", kind: "request_confirmation", result: { outcome: "rejected" } } }, session)).toMatchObject({ type: "plan_approval", isRejected: true });
  });
});
