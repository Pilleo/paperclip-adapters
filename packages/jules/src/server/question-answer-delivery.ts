import { createHash } from "node:crypto";
import { beginEffect, confirmEffect } from "./lifecycle-effect-journal.js";
import type { JulesAdapterSessionV1 } from "./session.js";
import { JulesClientError, type JulesClient } from "./jules-client.js";

/** Native decisions authorize one original-session message; uncertain delivery is observation-only. */
export async function deliverQuestionAnswer(input: {
  session: JulesAdapterSessionV1; activityId: string; answer: string;
  legacyDecisionAt?: string | null;
  client: Pick<JulesClient, "sendMessage" | "getActivities">; persist: () => Promise<void>;
}): Promise<"confirmed" | "await_observation"> {
  const { session, client, persist } = input;
  if (!session.julesSessionId || !input.answer.trim()) throw new Error("Question answer has no verified provider identity or content");
  if (session.deliveredFeedbackActivityId === input.activityId) return "confirmed";
  const effectId = `jules:question-answer:${session.paperclipIssueId}:${session.julesSessionId}:${input.activityId}`;
  const journal = session.lifecycleEffectJournal ?? { version: 1 as const, effects: [] };
  const existing = journal.effects.find(e => e.effectId === effectId);
  if (existing?.attempt.kind === "confirmed") return "confirmed";
  const marker = createHash("sha256").update(effectId).digest("hex");
  const prompt = `[paperclip:question-answer:${marker}] ${input.answer.trim()}`;
  if (session.questionAnswerIntent && (session.questionAnswerIntent.activityId !== input.activityId || session.questionAnswerIntent.prompt !== prompt)) {
    throw new Error("Uncertain question answer cannot be replaced by a different decision");
  }
  if (existing || input.legacyDecisionAt) {
    let token: string | undefined; const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const data = await client.getActivities(session.julesSessionId, token, 100);
      const decisionAt = Date.parse(input.legacyDecisionAt ?? "");
      const echo = data.activities.find(a => a.userMessaged?.userMessage === prompt ||
        (!existing && Number.isFinite(decisionAt) && Date.parse(a.createTime ?? "") >= decisionAt && a.userMessaged?.userMessage === input.answer.trim()));
      if (echo) {
        session.lifecycleEffectJournal = confirmEffect(beginEffect(journal, { effectId, kind: "send_provider_message", startedAt: new Date().toISOString() }), effectId, `provider:user-message:${echo.id}`);
        await persist(); return "confirmed";
      }
      if (!data.nextPageToken) {
        if (existing) return "await_observation";
        token = undefined;
        break;
      }
      if (seen.has(data.nextPageToken)) throw new Error("Question receipt scan repeated a page");
      seen.add(data.nextPageToken); token = data.nextPageToken;
    }
    if (token) throw new Error("Question receipt inventory is incomplete");
  }
  session.questionAnswerIntent = { activityId: input.activityId, prompt };
  session.lifecycleEffectJournal = beginEffect(journal, { effectId, kind: "send_provider_message", startedAt: new Date().toISOString() });
  await persist();
  try { await client.sendMessage(session.julesSessionId, { prompt }); }
  catch (error) {
    if (error instanceof JulesClientError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) throw error;
    console.warn("[jules] Question answer delivery is unverified; observing the original session receipt before any further mutation.");
    return "await_observation"; // The durable started effect remains unconfirmed; never repost it.
  }
  session.lifecycleEffectJournal = confirmEffect(session.lifecycleEffectJournal, effectId, "provider:question-answer-accepted");
  await persist(); return "confirmed";
}
