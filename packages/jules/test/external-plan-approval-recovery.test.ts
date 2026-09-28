import { describe, expect, it } from "vitest";
import { adoptExternallyApprovedPlan } from "../src/server/external-plan-approval-recovery.js";
import { persistExternalApprovalCheckpoint } from "../src/server/operator-approval-checkpoint.js";
import type { JulesAdapterSessionV1 } from "../src/server/session.js";
import { loadStoredSession, saveStoredSession } from "../src/server/session-store.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const session = {
  version: 1, paperclipIssueId: "issue-b", promptHash: "hash", source: "sources/github/o/r",
  repository: "o/r", baseBranch: "main", phase: "WAITING_FOR_PLAN_APPROVAL",
  sessionId: "session-b", julesSessionId: "session-b", attempt: 1, failedSessions: [],
  createdAt: "2026-09-27T20:00:00Z", childPlanReview: { identity: {
    version: 3, companyId: "company-1", parentIssueId: "issue-b", sessionId: "session-b",
    activityId: "activity-b", documentId: "document-b", revisionId: "revision-b", revisionNumber: 1,
    stage: "terra", reviewerAgentId: "gemini-agent", bootstrapAgentId: "bootstrap-agent", julesAgentId: "jules-agent",
  }, childId: "gemini-child" },
} as unknown as JulesAdapterSessionV1;
const receipt = { kind: "approve_plan", state: "accepted", httpStatus: 200, attempts: 1,
  effectId: "approve:session-b:revision-b", issueId: "issue-b", sessionId: "session-b",
  documentId: "document-b", revisionId: "revision-b", planActivityId: "activity-b",
  createdAt: "2026-09-27T20:02:00Z", reviewers: [
    { cardId: "luna-card", reviewerAgentId: "luna-agent", runId: "luna-run" },
    { cardId: "gemini-card", reviewerAgentId: "gemini-agent", runId: "gemini-run" },
  ] } as const;
const evidence = { receipt, providerActivities: [{ id: "activity-b", createTime: "2026-09-27T20:01:00Z",
  planGenerated: { plan: { id: "provider-plan", steps: [{ title: "Implement" }] } } },
{ id: "approval-b", createTime: "2026-09-27T20:03:00Z", planApproved: { planId: "provider-plan" } }],
  historyComplete: true, providerPrUrl: "https://github.com/o/r/pull/2", boardDocumentRevisionId: "revision-b" } as const;

describe("one-time externally journaled Jules approval adoption", () => {
  it("confirms the one accepted exact-plan effect, clears the child gate and survives repeated observation", () => {
    const adopted = adoptExternallyApprovedPlan(session, evidence);
    expect(adopted.childPlanReview).toBeUndefined();
    expect(adopted.planApprovedActivityId).toBe("activity-b");
    expect(adopted.planReviewOutcome).toBe("approved");
    expect(adopted.lifecycleEffectJournal?.effects).toEqual([{ effectId: "approve:session-b:revision-b",
      kind: "approve_plan", attempt: { kind: "confirmed", receipt: "provider:approval-b" } }]);
    expect(adoptExternallyApprovedPlan(adopted, evidence)).toEqual(adopted);
  });

  it("rejects changed revision, unverified provider activity or repeated reviewer identity", () => {
    expect(() => adoptExternallyApprovedPlan(session, { ...evidence, boardDocumentRevisionId: "new-revision" })).toThrow();
    expect(() => adoptExternallyApprovedPlan(session, { ...evidence,
      providerActivities: [evidence.providerActivities[0]], historyComplete: true })).toThrow();
    expect(() => adoptExternallyApprovedPlan(session, { ...evidence, receipt: { ...receipt,
      reviewers: [receipt.reviewers[0], { ...receipt.reviewers[1], runId: "luna-run" }] } })).toThrow();
    expect(() => adoptExternallyApprovedPlan(session, { ...evidence, receipt: { ...receipt, state: "uncertain" as const } })).toThrow();
  });

  it("persists one confirmed effect across a local checkpoint restart without a second approval", async () => {
    const prior = process.env["PAPERCLIP_JULES_SESSION_STORE_DIR"];
    const directory = await mkdtemp(join(tmpdir(), "jules-external-approval-"));
    process.env["PAPERCLIP_JULES_SESSION_STORE_DIR"] = directory;
    try {
      await saveStoredSession(session);
      const before = await loadStoredSession("issue-b", "sources/github/o/r", "main");
      expect(before).not.toBeNull();
      await saveStoredSession(adoptExternallyApprovedPlan(before!, evidence));
      const recovered = await loadStoredSession("issue-b", "sources/github/o/r", "main");
      expect(recovered?.lifecycleEffectJournal?.effects).toHaveLength(1);
      expect(adoptExternallyApprovedPlan(recovered!, evidence)).toEqual(recovered);
    } finally {
      if (prior === undefined) delete process.env["PAPERCLIP_JULES_SESSION_STORE_DIR"];
      else process.env["PAPERCLIP_JULES_SESSION_STORE_DIR"] = prior;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resumes an owner-only intent after the checkpoint was saved but its journal was not confirmed", async () => {
    const prior = process.env["PAPERCLIP_JULES_SESSION_STORE_DIR"];
    const directory = await mkdtemp(join(tmpdir(), "jules-approval-crash-"));
    process.env["PAPERCLIP_JULES_SESSION_STORE_DIR"] = directory;
    const journalPath = join(directory, "operator-intent.json");
    const intent = { state: "intent", effectId: receipt.effectId, issueId: receipt.issueId,
      sessionId: receipt.sessionId, revisionId: receipt.revisionId, providerPrUrl: evidence.providerPrUrl };
    try {
      await saveStoredSession(adoptExternallyApprovedPlan(session, evidence));
      await writeFile(journalPath, JSON.stringify(intent), { mode: 0o600 });
      const reloaded = await loadStoredSession("issue-b", "sources/github/o/r", "main");
      await persistExternalApprovalCheckpoint({ session: reloaded!, evidence, journalPath });
      expect((JSON.parse(await readFile(journalPath, "utf8")) as { state: string }).state).toBe("confirmed");
      expect((await loadStoredSession("issue-b", "sources/github/o/r", "main"))?.lifecycleEffectJournal?.effects).toHaveLength(1);
      await persistExternalApprovalCheckpoint({ session: (await loadStoredSession("issue-b", "sources/github/o/r", "main"))!, evidence, journalPath });
      expect((await loadStoredSession("issue-b", "sources/github/o/r", "main"))?.lifecycleEffectJournal?.effects).toHaveLength(1);
    } finally {
      if (prior === undefined) delete process.env["PAPERCLIP_JULES_SESSION_STORE_DIR"];
      else process.env["PAPERCLIP_JULES_SESSION_STORE_DIR"] = prior;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resumes an owner-only intent saved before the checkpoint write", async () => {
    const prior = process.env["PAPERCLIP_JULES_SESSION_STORE_DIR"];
    const directory = await mkdtemp(join(tmpdir(), "jules-approval-before-save-"));
    process.env["PAPERCLIP_JULES_SESSION_STORE_DIR"] = directory;
    const journalPath = join(directory, "operator-intent.json");
    try {
      await saveStoredSession(session);
      await writeFile(journalPath, JSON.stringify({ state: "intent", effectId: receipt.effectId,
        issueId: receipt.issueId, sessionId: receipt.sessionId, revisionId: receipt.revisionId,
        providerPrUrl: evidence.providerPrUrl }), { mode: 0o600 });
      const before = await loadStoredSession("issue-b", "sources/github/o/r", "main");
      expect((await persistExternalApprovalCheckpoint({ session: before!, evidence, journalPath })).status).toBe("confirmed");
      expect((JSON.parse(await readFile(journalPath, "utf8")) as { state: string }).state).toBe("confirmed");
      expect((await loadStoredSession("issue-b", "sources/github/o/r", "main"))?.lifecycleEffectJournal?.effects).toHaveLength(1);
    } finally {
      if (prior === undefined) delete process.env["PAPERCLIP_JULES_SESSION_STORE_DIR"];
      else process.env["PAPERCLIP_JULES_SESSION_STORE_DIR"] = prior;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
