const SESSION_URL_RE = /jules\.google\.com\/session\/([A-Za-z0-9_-]+)/i;
const SESSION_ID_LINE_RE = /(?:julesSessionId|sessionId)\s*[:=]\s*["']?([A-Za-z0-9_-]+)/i;

export const JULES_SESSION_DOCUMENT_KEY = "jules-session";

/**
 * Public, non-secret recovery identity owned by the Jules assignee.  Paperclip
 * intentionally projects only a small wake context, so a native review wake
 * cannot carry arbitrary adapter payload reliably.  Persisting the immutable
 * PR head here lets Jules recover a structured verdict after restarts without
 * trusting prose, URL-only matches, or an orchestrator cross-issue write.
 */
export interface JulesSessionHandle {
  readonly sessionId: string;
  readonly sessionUrl?: string;
  readonly prUrl?: string;
  readonly headSha?: string;
  /** Immutable GitHub branch for branch-bound PR remediation. */
  readonly headRefName?: string;
  readonly deliveredFeedbackActivityId?: string;
  readonly deliveredFeedbackInteractionId?: string;
  /**
   * A branch-bound recovery is a durable single-flight fence, not transient
   * runtime state.  Without it a status/ownership replay can forget that a
   * remediation session already exists and start a second Jules session for
   * the same immutable PR branch.
   */
  readonly remediation?: {
    readonly originalSessionId: string;
    readonly recoverySessionId: string;
    readonly reason: "ci_failure" | "terminal_plan_revision_unavailable";
  };
}

export function extractJulesSessionId(text: string | null | undefined): string | null {
  if (!text) return null;
  const fromUrl = text.match(SESSION_URL_RE);
  if (fromUrl?.[1]) return fromUrl[1];
  const fromLine = text.match(SESSION_ID_LINE_RE);
  if (fromLine?.[1]) return fromLine[1];
  return null;
}

export function julesSessionUrl(sessionId: string, existingUrl?: string | null): string {
  if (existingUrl && existingUrl.includes(sessionId)) return existingUrl;
  return `https://jules.google.com/session/${sessionId}`;
}

export function formatJulesSessionHandleBody(
  sessionId: string,
  url?: string | null,
  pr?: { readonly prUrl?: string | null; readonly headSha?: string | null; readonly headRefName?: string | null },
  delivery?: { readonly deliveredFeedbackActivityId?: string | null; readonly deliveredFeedbackInteractionId?: string | null },
  remediation?: {
    readonly originalSessionId?: string | null;
    readonly recoverySessionId?: string | null;
    readonly reason?: "ci_failure" | "terminal_plan_revision_unavailable" | null;
  },
): string {
  return [
    `julesSessionId: ${sessionId}`,
    `url: ${julesSessionUrl(sessionId, url)}`,
    ...(pr?.prUrl ? [`prUrl: ${pr.prUrl}`] : []),
    ...(pr?.headSha ? [`prHeadSha: ${pr.headSha}`] : []),
    ...(pr?.headRefName ? [`prHeadRef: ${pr.headRefName}`] : []),
    ...(delivery?.deliveredFeedbackActivityId ? [`deliveredFeedbackActivityId: ${delivery.deliveredFeedbackActivityId}`] : []),
    ...(delivery?.deliveredFeedbackInteractionId ? [`deliveredFeedbackInteractionId: ${delivery.deliveredFeedbackInteractionId}`] : []),
    ...(remediation?.originalSessionId ? [`prRemediationOriginalSessionId: ${remediation.originalSessionId}`] : []),
    ...(remediation?.recoverySessionId ? [`prRemediationRecoverySessionId: ${remediation.recoverySessionId}`] : []),
    ...(remediation?.reason ? [`prRemediationReason: ${remediation.reason}`] : []),
  ].join("\n");
}

function lineValue(text: string, key: string): string | undefined {
  const match = text.match(new RegExp(`^${key}\\s*:\\s*(\\S.*?)\\s*$`, "mi"));
  return match?.[1]?.trim() || undefined;
}

export function parseJulesSessionHandle(text: string | null | undefined): JulesSessionHandle | null {
  const sessionId = extractJulesSessionId(text);
  if (!sessionId || !text) return null;
  const sessionUrl = lineValue(text, "url");
  const prUrl = lineValue(text, "prUrl");
  const headSha = lineValue(text, "prHeadSha");
  const headRefName = lineValue(text, "prHeadRef");
  const deliveredFeedbackActivityId = lineValue(text, "deliveredFeedbackActivityId");
  const deliveredFeedbackInteractionId = lineValue(text, "deliveredFeedbackInteractionId");
  const remediationOriginalSessionId = lineValue(text, "prRemediationOriginalSessionId");
  const remediationRecoverySessionId = lineValue(text, "prRemediationRecoverySessionId");
  const remediationReason = lineValue(text, "prRemediationReason");
  const remediation: JulesSessionHandle["remediation"] = remediationOriginalSessionId && remediationRecoverySessionId &&
    (remediationReason === "ci_failure" || remediationReason === "terminal_plan_revision_unavailable")
    ? {
        originalSessionId: remediationOriginalSessionId,
        recoverySessionId: remediationRecoverySessionId,
        reason: remediationReason,
      }
    : undefined;
  return {
    sessionId,
    ...(sessionUrl ? { sessionUrl } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(headSha ? { headSha } : {}),
    ...(headRefName ? { headRefName } : {}),
    ...(deliveredFeedbackActivityId ? { deliveredFeedbackActivityId } : {}),
    ...(deliveredFeedbackInteractionId ? { deliveredFeedbackInteractionId } : {}),
    ...(remediation ? { remediation } : {}),
  };
}

export function extractJulesSessionIdFromComments(
  comments: readonly { body?: string | null; createdAt?: string | null }[],
): string | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const id = extractJulesSessionId(comments[i]?.body);
    if (id) return id;
  }
  return null;
}
