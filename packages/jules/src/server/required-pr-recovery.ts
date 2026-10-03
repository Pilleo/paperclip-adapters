import { createHash } from "node:crypto";
import { parseTaskContract } from "@pilleo/paperclip-adapter-common";
import { beginEffect, confirmEffect } from "./lifecycle-effect-journal.js";
import type { JulesAdapterSessionV1 } from "./session.js";
import type { JulesClient } from "./jules-client.js";

export function taskRequiresPullRequest(description: string): boolean {
  // This is an explicit user task obligation, never inferred from provider prose.
  return /\b(?:create|open|publish)\s+exactly\s+one\s+(?:PR|pull request)\b/i.test(parseTaskContract(description).requirements);
}

export type RequiredPrRecovery = "requested" | "await_observation" | "exhausted";

/** One durable, original-session continuation. An uncertain POST is never replayed. */
export async function recoverRequiredPullRequest(input: {
  readonly session: JulesAdapterSessionV1;
  readonly description: string;
  readonly client: Pick<JulesClient, "sendMessage" | "getActivities">;
  readonly persist: () => Promise<void>;
}): Promise<RequiredPrRecovery> {
  const { session, client, persist } = input;
  if (!session.julesSessionId) throw new Error("Required-PR recovery has no original provider identity");
  const effectId = `jules:required-pr-continuation:${session.paperclipIssueId}:${session.julesSessionId}:v1`;
  const marker = createHash("sha256").update(effectId).digest("hex");
  const contract = parseTaskContract(input.description);
  const prompt = `[paperclip:required-pr:${marker}] Continue this same Jules session for Paperclip issue ${session.paperclipIssueId}. ` +
    "The approved task is not complete: it requires exactly one pull request, but none was published. " +
    "Finish the scoped implementation, run the declared tests, commit and push it, and create exactly one pull request in the existing repository. " +
    "Do not create a new provider session, replace the task, merge a PR, or modify unrelated work. " +
    (contract.kind === "structured" ? `Stay within: ${contract.targetFiles.join(", ")}. ` : "") +
    `Original task requirements:\n${contract.requirements}`;
  const journal = session.lifecycleEffectJournal ?? { version: 1 as const, effects: [] };
  const existing = journal.effects.find((effect) => effect.effectId === effectId);
  if (existing) {
    let token: string | undefined;
    const seen = new Set<string>();
    const activities = [];
    for (let page = 0; page < 20; page++) {
      const response = await client.getActivities(session.julesSessionId, token, 100);
      activities.push(...response.activities);
      if (!response.nextPageToken) {
        const echo = activities.find((activity) => activity.userMessaged?.userMessage === prompt);
        if (!echo) return "await_observation";
        if (existing.attempt.kind === "started") {
          session.lifecycleEffectJournal = confirmEffect(journal, effectId, `provider:user-message:${echo.id}`);
          await persist();
          return "requested";
        }
        const echoAt = Date.parse(echo.createTime ?? "");
        const completedWork = activities.some((activity) => Date.parse(activity.createTime ?? "") > echoAt &&
          (activity.sessionCompleted !== undefined || activity.agentMessaged !== undefined || activity.progressUpdated !== undefined));
        return completedWork ? "exhausted" : "await_observation";
      }
      if (seen.has(response.nextPageToken)) throw new Error("Required-PR receipt scan repeated a page");
      seen.add(response.nextPageToken); token = response.nextPageToken;
    }
    throw new Error("Required-PR receipt inventory is incomplete");
  }
  session.lifecycleEffectJournal = beginEffect(journal, { effectId, kind: "send_provider_message", startedAt: new Date().toISOString() });
  await persist();
  await client.sendMessage(session.julesSessionId, { prompt });
  session.lifecycleEffectJournal = confirmEffect(session.lifecycleEffectJournal, effectId, "provider:required-pr-message-accepted");
  await persist();
  return "requested";
}
