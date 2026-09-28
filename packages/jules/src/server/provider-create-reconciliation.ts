import { createHash } from "node:crypto";
import type { JulesSession } from "./jules-client.js";

export interface ProviderCreateIntent {
  readonly requestId: string;
  readonly runId: string;
  readonly promptSha256: string;
  readonly source: string;
  readonly baseBranch: string;
  readonly startedAt: string;
}

export interface ProviderCreateCandidate {
  readonly id: string;
  readonly promptSha256: string;
  readonly source: string;
  readonly baseBranch: string;
  readonly createdAt?: string | undefined;
}

export type ProviderCreateRecovery =
  | { readonly kind: "reattach"; readonly sessionId: string }
  | { readonly kind: "hold"; readonly reason: "no_exact_session" | "ambiguous_session" | "incomplete_history" };

/** Walk the complete bounded provider index; never treat a partial page as absence. */
export async function observeProviderCreateIntent(
  client: { listSessions: (pageSize: number, pageToken?: string) => Promise<{ sessions: JulesSession[]; nextPageToken?: string | undefined }> },
  intent: ProviderCreateIntent,
): Promise<{ readonly kind: "reattach"; readonly sessionId: string; readonly session: JulesSession } |
  Extract<ProviderCreateRecovery, { readonly kind: "hold" }>> {
  const sessions: JulesSession[] = [];
  const tokens = new Set<string>();
  let nextPageToken: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await client.listSessions(100, nextPageToken);
    sessions.push(...result.sessions);
    nextPageToken = result.nextPageToken;
    if (!nextPageToken) {
      const decision = decideProviderCreateRecovery(intent, sessions.filter((session) => session.prompt).map((session) => ({
        id: session.id, promptSha256: createHash("sha256").update(session.prompt!).digest("hex"),
        source: session.source ?? "", baseBranch: session.baseBranch ?? "", createdAt: session.createTime,
      })), true);
      if (decision.kind !== "reattach") return decision;
      const session = sessions.find((candidate) => candidate.id === decision.sessionId);
      return session ? { ...decision, session } : { kind: "hold", reason: "no_exact_session" };
    }
    if (tokens.has(nextPageToken)) return { kind: "hold", reason: "incomplete_history" };
    tokens.add(nextPageToken);
  }
  return { kind: "hold", reason: "incomplete_history" };
}

/** A lost POST response does not establish absence. Never infer retry safety from an empty list. */
export function decideProviderCreateRecovery(
  intent: ProviderCreateIntent,
  candidates: readonly ProviderCreateCandidate[],
  complete: boolean,
): ProviderCreateRecovery {
  if (!complete) return { kind: "hold", reason: "incomplete_history" };
  const started = Date.parse(intent.startedAt);
  const matches = candidates.filter((candidate) =>
    candidate.promptSha256 === intent.promptSha256 && candidate.source === intent.source &&
    candidate.baseBranch === intent.baseBranch &&
    (!candidate.createdAt || !Number.isFinite(started) || Date.parse(candidate.createdAt) >= started - 60_000));
  if (matches.length !== 1) return { kind: "hold", reason: matches.length ? "ambiguous_session" : "no_exact_session" };
  return { kind: "reattach", sessionId: matches[0]!.id };
}
