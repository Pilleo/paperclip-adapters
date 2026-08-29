import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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
});
