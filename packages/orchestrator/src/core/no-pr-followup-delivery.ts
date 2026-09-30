import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";

export async function deliverNoPrFollowupOnce(input: {
  readonly issueId: string; readonly sessionId: string; readonly marker: string;
  readonly prompt: string; readonly journalPath: string;
  readonly send: () => Promise<void>;
  readonly userMessages: () => Promise<readonly string[]>;
}): Promise<"awaiting_echo" | "observed_echo"> {
  if (!input.marker || !input.prompt.startsWith(`[${input.marker}] `) ||
      !input.issueId || !input.sessionId) throw new Error("invalid_original_session_followup");
  const promptSha256 = createHash("sha256").update(input.prompt).digest("hex");
  const lock = await open(`${input.journalPath}.lock`, "wx", 0o600);
  try {
    const journal = await open(input.journalPath, "a+", 0o600);
    try {
      const stat = await journal.stat();
      if ((stat.mode & 0o077) !== 0) throw new Error("followup_journal_must_be_owner_only");
      const contents = await journal.readFile("utf8");
      const events = contents.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      const intents = events.filter((entry) => entry["event"] === "send_intent");
      if (intents.length > 1 || intents.some((entry) => entry["issueId"] !== input.issueId ||
          entry["sessionId"] !== input.sessionId || entry["marker"] !== input.marker ||
          entry["promptSha256"] !== promptSha256)) throw new Error("existing_intent_mismatch");
      const append = async (event: string) => {
        await journal.appendFile(`${JSON.stringify({ event, issueId: input.issueId, sessionId: input.sessionId,
          marker: input.marker, promptSha256, at: new Date().toISOString() })}\n`);
        await journal.sync();
      };
      const messages = await input.userMessages();
      if (messages.some((message) => message === input.prompt)) {
        if (!events.some((entry) => entry["event"] === "provider_echo")) await append("provider_echo");
        return "observed_echo";
      }
      if (intents.length) return "awaiting_echo";
      await append("send_intent");
      try {
        await input.send();
      } catch {
        throw new Error("provider_delivery_uncertain");
      }
      await append("send_ack");
      return "awaiting_echo";
    } finally {
      await journal.close();
    }
  } finally {
    await lock.close();
    await unlink(`${input.journalPath}.lock`);
  }
}
