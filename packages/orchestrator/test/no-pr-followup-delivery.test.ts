import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deliverNoPrFollowupOnce } from "../src/core/no-pr-followup-delivery.js";

describe("original-session no-PR provider delivery", () => {
  const directories: string[] = [];
  afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
  const setup = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "no-pr-delivery-"));
    directories.push(dir);
    return path.join(dir, "receipts.jsonl");
  };
  const input = { issueId: "issue-original", sessionId: "session-original",
    marker: "paperclip:pr-required-followup:immutable", prompt: "[paperclip:pr-required-followup:immutable] Finish and open the original PR." };

  it("never repeats a provider message whose accepted response was lost before an exact echo appears", async () => {
    const journalPath = await setup();
    let attempts = 0;
    const send = async () => { attempts++; throw new Error("accepted by provider; response lost"); };
    await expect(deliverNoPrFollowupOnce({ ...input, journalPath, send,
      userMessages: async () => [] })).rejects.toThrow("provider_delivery_uncertain");
    const intent = JSON.parse((await readFile(journalPath, "utf8")).trim().split("\n").at(-1)!);
    expect(intent).toMatchObject({ event: "send_intent", issueId: "issue-original", sessionId: "session-original" });
    expect(await deliverNoPrFollowupOnce({ ...input, journalPath, send, userMessages: async () => [] }))
      .toBe("awaiting_echo");
    expect(attempts).toBe(1);
    expect(await deliverNoPrFollowupOnce({ ...input, journalPath, send,
      userMessages: async () => [input.prompt] })).toBe("observed_echo");
    expect(attempts).toBe(1);
  });

  it("allows one send only for the bound original issue, session and immutable prompt", async () => {
    const journalPath = await setup();
    let attempts = 0;
    const send = async () => { attempts++; };
    expect(await deliverNoPrFollowupOnce({ ...input, journalPath, send,
      userMessages: async () => [] })).toBe("awaiting_echo");
    await expect(deliverNoPrFollowupOnce({ ...input, sessionId: "replacement", journalPath, send,
      userMessages: async () => [] })).rejects.toThrow("existing_intent_mismatch");
    expect(attempts).toBe(1);
  });
});
