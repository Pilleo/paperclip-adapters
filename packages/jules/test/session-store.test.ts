import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteStoredSession, loadStoredSession, saveStoredSession } from "../src/server/session-store";

describe("Jules local session recovery store", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "jules-session-store-"));
    process.env.PAPERCLIP_JULES_SESSION_STORE_DIR = directory;
  });

  afterEach(async () => {
    delete process.env.PAPERCLIP_JULES_SESSION_STORE_DIR;
    await rm(directory, { recursive: true, force: true });
  });

  it("restores a session only for the same task and repository identity", async () => {
    await saveStoredSession({
      version: 1,
      paperclipIssueId: "issue-1" as any,
      promptHash: "hash",
      repository: "owner/repo",
      source: "sources/github/owner/repo",
      baseBranch: "main",
      phase: "RUNNING",
      sessionId: "session-123",
      julesSessionId: "session-123" as any,
      attempt: 1,
      failedSessions: [],
      createdAt: "2026-08-06T10:00:00.000Z",
    });

    await expect(loadStoredSession("issue-1", "sources/github/owner/repo", "main"))
      .resolves.toMatchObject({ sessionId: "session-123", julesSessionId: "session-123" });
    await expect(loadStoredSession("issue-2", "sources/github/owner/repo", "main"))
      .resolves.toBeNull();
    await expect(loadStoredSession("issue-1", "sources/github/other/repo", "main"))
      .resolves.toBeNull();
  });

  it("deletes the recovery record after terminal completion", async () => {
    const session = {
      version: 1 as const, paperclipIssueId: "issue-1" as any, promptHash: "hash",
      repository: "owner/repo", source: "sources/github/owner/repo", baseBranch: "main",
      phase: "RUNNING" as const, sessionId: "session-123", julesSessionId: "session-123" as any,
      attempt: 1, failedSessions: [], createdAt: "2026-08-06T10:00:00.000Z",
    };
    await saveStoredSession(session);
    await deleteStoredSession("issue-1", "sources/github/owner/repo", "main");
    await expect(loadStoredSession("issue-1", "sources/github/owner/repo", "main")).resolves.toBeNull();
  });
  it("fails closed on a present but malformed prepared-create record", async () => {
    const key = createHash("sha256").update("issue-1\0sources/github/owner/repo\0main").digest("hex");
    await writeFile(join(directory, `${key}.json`), JSON.stringify({ phase: "STARTING", providerCreateIntent: { requestId: "request-1" } }));
    await expect(loadStoredSession("issue-1", "sources/github/owner/repo", "main"))
      .rejects.toThrow(/invalid durable Jules session/i);
  });

  it("round-trips a started lifecycle effect so restart recovery reconciles it", async () => {
    await saveStoredSession({
      version: 1,
      paperclipIssueId: "issue-1" as any,
      promptHash: "hash",
      repository: "owner/repo",
      source: "sources/github/owner/repo",
      baseBranch: "main",
      phase: "RUNNING",
      sessionId: "session-123",
      julesSessionId: "session-123" as any,
      attempt: 1,
      failedSessions: [],
      lifecycleEffectJournal: {
        version: 1,
        effects: [{
          effectId: "verdict:card-1",
          kind: "deliver_verdict",
          attempt: { kind: "started", startedAt: "2026-09-20T00:00:00.000Z" },
        }],
      },
      createdAt: "2026-08-06T10:00:00.000Z",
    } as any);

    await expect(loadStoredSession("issue-1", "sources/github/owner/repo", "main"))
      .resolves.toMatchObject({
        lifecycleEffectJournal: {
          effects: [{ effectId: "verdict:card-1", attempt: { kind: "started" } }],
        },
      });
  });

  it("migrates an unconfirmed legacy mutation checkpoint to reconciliation evidence", async () => {
    await saveStoredSession({
      version: 1,
      paperclipIssueId: "issue-1" as any,
      promptHash: "hash",
      repository: "owner/repo",
      source: "sources/github/owner/repo",
      baseBranch: "main",
      phase: "RUNNING",
      sessionId: "session-123",
      julesSessionId: "session-123" as any,
      attempt: 1,
      failedSessions: [],
      mutationCheckpoint: {
        version: 1,
        key: "legacy:message:card-1",
        operation: "send_message",
        issueId: "issue-1",
        status: "pending",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
      createdAt: "2026-08-06T10:00:00.000Z",
    } as any);

    await expect(loadStoredSession("issue-1", "sources/github/owner/repo", "main"))
      .resolves.toMatchObject({
        lifecycleEffectJournal: {
          effects: [{ effectId: "legacy:message:card-1", kind: "legacy_unknown", attempt: { kind: "started" } }],
        },
      });
  });
});
