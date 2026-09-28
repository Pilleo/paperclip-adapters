import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qualifyTerminalRevisionStep } from "../scripts/qualify-terminal-revision.js";
import { planRevisionRequestPrompt } from "../src/server/plan-revision-request.js";

describe("one journaled terminal-session revision qualification", () => {
  it("sends an exact typed rejection at most once even across restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "terminal-revision-probe-"));
    try {
      const manifestPath = join(directory, "probe.json");
      const client = {
        sendMessage: vi.fn().mockResolvedValue({}),
        getActivities: vi.fn().mockResolvedValue({ activities: [] }),
        getSession: vi.fn().mockResolvedValue({ id: "session-1", state: "COMPLETED" }),
      };
      const input = { client, manifestPath, sessionId: "session-1", interactionId: "typed-card-1",
        planActivityId: "plan-1", reason: "Add exact tests", sendAllowed: true };
      await qualifyTerminalRevisionStep(input);
      await qualifyTerminalRevisionStep(input);
      expect(client.sendMessage).toHaveBeenCalledTimes(1);
      expect(client.sendMessage.mock.calls[0]?.[1]?.prompt).toContain("[paperclip-plan-cycle:typed-card-1]");
      expect(await readFile(manifestPath, "utf8")).not.toContain("Add exact tests");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("does not send when the exact typed rejection marker already appears in provider activity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "terminal-revision-echo-"));
    try {
      const prompt = planRevisionRequestPrompt({ interactionId: "typed-card-1", reviewerFeedback: "Add exact tests" });
      const client = { sendMessage: vi.fn(), getSession: vi.fn().mockResolvedValue({ state: "COMPLETED" }),
        getActivities: vi.fn().mockResolvedValue({ activities: [{ id: "echo", userMessaged: { userMessage: prompt } }] }) };
      const result = await qualifyTerminalRevisionStep({ client, manifestPath: join(directory, "probe.json"),
        sessionId: "session-1", interactionId: "typed-card-1", planActivityId: "plan-1", reason: "Add exact tests", sendAllowed: true });
      expect(result.state).toBe("echoed");
      expect(client.sendMessage).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
