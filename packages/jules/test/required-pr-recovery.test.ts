import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recoverRequiredPullRequest, taskRequiresPullRequest } from "../src/server/required-pr-recovery.js";
import { loadStoredSession, saveStoredSession } from "../src/server/session-store.js";
import type { JulesAdapterSessionV1 } from "../src/server/session.js";

const originalStore = process.env.PAPERCLIP_JULES_SESSION_STORE_DIR;
const roots: string[] = [];
afterEach(async () => {
  if (originalStore === undefined) delete process.env.PAPERCLIP_JULES_SESSION_STORE_DIR;
  else process.env.PAPERCLIP_JULES_SESSION_STORE_DIR = originalStore;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const makeSession = (): JulesAdapterSessionV1 => ({ version: 1, paperclipIssueId: "issue", promptHash: "hash",
  repository: "acme/repo", source: "sources/github/acme/repo", baseBranch: "main", phase: "COMPLETED",
  sessionId: "original", julesSessionId: "original", attempt: 1, failedSessions: [], createdAt: "2026-10-03T00:00:00.000Z" });

describe("durable original-session required-PR recovery", () => {
  it("distinguishes an explicit PR obligation from generic completion without parsing provider prose", () => {
    expect(taskRequiresPullRequest("Create exactly one PR for this task.")).toBe(true);
    expect(taskRequiresPullRequest("Open exactly one pull request against main.")).toBe(true);
    expect(taskRequiresPullRequest("Do not change files")).toBe(false);
  });

  it("persists before send and observes lost acknowledgement after restart without replay", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "required-pr-outbox-")); roots.push(root);
    process.env.PAPERCLIP_JULES_SESSION_STORE_DIR = root;
    let session = makeSession(); let sends = 0; let prompt = ""; let echo = false;
    const client = { sendMessage: async (id: string, body: { prompt: string }) => {
      expect(id).toBe("original");
      const persisted = await loadStoredSession("issue", session.source, "main");
      expect(persisted?.lifecycleEffectJournal?.effects[0]?.attempt.kind).toBe("started");
      sends++; prompt = body.prompt; throw new Error("accepted remotely; acknowledgement lost");
    }, getActivities: async () => ({ activities: echo ? [{ id: "echo", createTime: "2026-10-03T00:00:01.000Z", userMessaged: { userMessage: prompt } }] : [] }) };
    const input = () => ({ session, description: "Create exactly one PR for this task.", client: client as never, persist: () => saveStoredSession(session) });
    await expect(recoverRequiredPullRequest(input())).rejects.toThrow("acknowledgement lost");
    session = (await loadStoredSession("issue", session.source, "main"))!;
    expect(await recoverRequiredPullRequest(input())).toBe("await_observation");
    echo = true;
    expect(await recoverRequiredPullRequest(input())).toBe("requested");
    expect(sends).toBe(1);
    expect((await loadStoredSession("issue", session.source, "main"))?.julesSessionId).toBe("original");
  });

  it("does not send when durable intent persistence fails", async () => {
    let sends = 0;
    const client = { sendMessage: async () => { sends++; }, getActivities: async () => ({ activities: [] }) };
    await expect(recoverRequiredPullRequest({ session: makeSession(), description: "Create exactly one PR", client: client as never,
      persist: async () => { throw new Error("checkpoint unavailable"); } })).rejects.toThrow("checkpoint unavailable");
    expect(sends).toBe(0);
  });
});
