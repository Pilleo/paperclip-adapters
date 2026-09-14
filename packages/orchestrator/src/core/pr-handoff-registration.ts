export interface PrHandoffRegistrationInput {
  readonly issueId?: string;
  readonly managed: boolean;
  readonly registered: boolean;
  /** Immutable head recorded on the existing primary PR work product. */
  readonly registeredHeadSha?: string | undefined;
  readonly ciGreen: boolean;
  readonly pr: { readonly number: number; readonly url: string; readonly headSha: string } | null;
  /**
   * Durable, adapter-owned fallback for a PR whose initial work-product write
   * was interrupted. It is accepted only when it binds the exact GitHub PR
   * and immutable head discovered by the orchestrator.
   */
  readonly sessionHandle?: {
    readonly sessionId: string;
    readonly prUrl: string;
    readonly headSha: string;
  } | undefined;
}

export interface JulesPrHandoffHandle {
  readonly sessionId: string;
  readonly prUrl: string;
  readonly headSha: string;
}

/**
 * Parses only the adapter-owned, versioned fields of the `jules-session`
 * document. Ordinary comments and a URL alone are intentionally not evidence
 * of a PR handoff: both the provider session and immutable PR head are needed
 * before the orchestrator may suppress implementation dispatch.
 */
export function parseJulesPrHandoffHandle(body: unknown): JulesPrHandoffHandle | null {
  if (typeof body !== "string") return null;
  const value = (key: string): string | null => {
    const match = body.match(new RegExp(`^${key}\\s*:\\s*(\\S.*?)\\s*$`, "mi"));
    return match?.[1]?.trim() || null;
  };
  const sessionId = value("julesSessionId");
  const prUrl = value("prUrl");
  const headSha = value("prHeadSha");
  if (!sessionId || !prUrl || !headSha || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?$/i.test(prUrl)) {
    return null;
  }
  return { sessionId, prUrl, headSha };
}

export type PrHandoffRegistrationDecision =
  | { readonly action: "no_action"; readonly reason: string }
  | { readonly action: "wait"; readonly reason: string }
  | { readonly action: "refuse"; readonly reason: string }
  | { readonly action: "register"; readonly key: string; readonly pr: NonNullable<PrHandoffRegistrationInput["pr"]>; readonly reason: string }
  | { readonly action: "register_from_session_handle"; readonly key: string; readonly pr: NonNullable<PrHandoffRegistrationInput["pr"]>; readonly sessionId: string; readonly reason: string }
  | { readonly action: "update"; readonly key: string; readonly pr: NonNullable<PrHandoffRegistrationInput["pr"]>; readonly reason: string };

type SessionHandleMatch =
  | { readonly kind: "absent" }
  | { readonly kind: "matches"; readonly sessionId: string }
  | { readonly kind: "mismatch" };

function evaluateSessionHandleMatch(
  handle: PrHandoffRegistrationInput["sessionHandle"],
  pr: NonNullable<PrHandoffRegistrationInput["pr"]>,
): SessionHandleMatch {
  if (!handle) return { kind: "absent" };
  const normalizedHandleUrl = handle.prUrl.replace(/\/$/, "").toLowerCase();
  const normalizedPrUrl = pr.url.replace(/\/$/, "").toLowerCase();
  if (!handle.sessionId.trim() || normalizedHandleUrl !== normalizedPrUrl || handle.headSha !== pr.headSha) {
    return { kind: "mismatch" };
  }
  return { kind: "matches", sessionId: handle.sessionId };
}

export function planPrHandoffRegistration(input: PrHandoffRegistrationInput): PrHandoffRegistrationDecision {
  if (!input.managed || !input.pr) return { action: "no_action", reason: "PR handoff is absent or unmanaged" };
  const handleMatch = evaluateSessionHandleMatch(input.sessionHandle, input.pr);
  switch (handleMatch.kind) {
    case "mismatch":
      return { action: "refuse", reason: `Jules session handle does not bind the discovered immutable PR head for #${input.pr.number}` };
    case "matches":
      if (!input.registered) {
        return {
          action: "register_from_session_handle",
          key: `pr-handoff:${input.issueId ?? "unknown"}:${input.pr.headSha}`,
          pr: input.pr,
          sessionId: handleMatch.sessionId,
          reason: `Jules session ${handleMatch.sessionId} durably binds PR #${input.pr.number} to the discovered immutable head`,
        };
      }
      break;
    case "absent":
      break;
  }
  // CI controls native-review eligibility, not whether a provider has
  // authoritatively delivered an existing PR. Retaining a verified handoff
  // while CI is red is what lets the Jules owner remediate that same branch
  // instead of falling back to a base-branch retry.
  if (!input.ciGreen) return { action: "wait", reason: `PR #${input.pr.number} CI is not green` };
  if (input.registered) {
    // Older Paperclip products did not persist the head. Keep those products
    // stable during rollout; only an observed, mismatching immutable head can
    // authorize an update.
    if (!input.registeredHeadSha || input.registeredHeadSha === input.pr.headSha) {
      return { action: "no_action", reason: "PR handoff is already registered for the current immutable head" };
    }
    return {
      action: "update",
      key: `pr-handoff:${input.issueId ?? "unknown"}:${input.pr.headSha}`,
      pr: input.pr,
      reason: `PR #${input.pr.number} advanced and must update its registered handoff`,
    };
  }
  return {
    action: "register",
    key: `pr-handoff:${input.issueId ?? "unknown"}:${input.pr.headSha}`,
    pr: input.pr,
    reason: `PR #${input.pr.number} is green and must be registered for native review`,
  };
}
