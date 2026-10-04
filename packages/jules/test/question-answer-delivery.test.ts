import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverQuestionAnswer } from "../src/server/question-answer-delivery.js";
import { loadStoredSession, saveStoredSession } from "../src/server/session-store.js";
import type { JulesAdapterSessionV1 } from "../src/server/session.js";

const session = (): JulesAdapterSessionV1 => ({ version: 1, paperclipIssueId: "question-task", source: "source", repository: "repo", baseBranch: "main",
  promptHash: "hash", phase: "WAITING_FOR_FEEDBACK", julesSessionId: "original", sessionId: "original", attempt: 1, failedSessions: [], createdAt: new Date().toISOString() });
let directory: string | undefined;
afterEach(async () => { delete process.env.PAPERCLIP_JULES_SESSION_STORE_DIR; if (directory) await rm(directory, { recursive: true, force: true }); });

describe("question answer outbox", () => {
  it("persists intent before sending and observes an accepted lost reply across restart without replay", async () => {
    directory = await mkdtemp(join(tmpdir(), "question-answer-test-")); process.env.PAPERCLIP_JULES_SESSION_STORE_DIR = directory;
    let message = "", posts = 0;
    const state = session();
    const client = {
      sendMessage: async (_id: string, body: { prompt: string }) => {
        const durable = await loadStoredSession("question-task", "source", "main");
        expect(durable?.lifecycleEffectJournal?.effects.at(-1)?.attempt.kind).toBe("started");
        message = body.prompt; posts++; throw new Error("accepted response lost");
      },
      getActivities: async () => ({ activities: [{ id: "echo", createTime: new Date().toISOString(), userMessaged: { userMessage: message } }] }),
    };
    expect(await deliverQuestionAnswer({ session: state, activityId: "activity", answer: "Proceed within the approved plan.", client,
      persist: () => saveStoredSession(state) })).toBe("await_observation");
    const recovered = (await loadStoredSession("question-task", "source", "main"))!;
    expect(await deliverQuestionAnswer({ session: recovered, activityId: "activity", answer: "Proceed within the approved plan.", client,
      persist: () => saveStoredSession(recovered) })).toBe("confirmed");
    expect(posts).toBe(1);
  });

  it("does not send when durable intent cannot be saved", async () => {
    let posts = 0;
    await expect(deliverQuestionAnswer({ session: session(), activityId: "activity", answer: "Proceed", client: {
      sendMessage: async () => { posts++; }, getActivities: async () => ({ activities: [] }),
    }, persist: async () => { throw new Error("disk failed"); } })).rejects.toThrow("disk failed");
    expect(posts).toBe(0);
  });
});
