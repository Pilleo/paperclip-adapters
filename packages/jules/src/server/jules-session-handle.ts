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
  pr?: { readonly prUrl?: string | null; readonly headSha?: string | null },
): string {
  return [
    `julesSessionId: ${sessionId}`,
    `url: ${julesSessionUrl(sessionId, url)}`,
    ...(pr?.prUrl ? [`prUrl: ${pr.prUrl}`] : []),
    ...(pr?.headSha ? [`prHeadSha: ${pr.headSha}`] : []),
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
  return {
    sessionId,
    ...(sessionUrl ? { sessionUrl } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(headSha ? { headSha } : {}),
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
