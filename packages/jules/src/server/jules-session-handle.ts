const SESSION_URL_RE = /jules\.google\.com\/session\/([A-Za-z0-9_-]+)/i;
const SESSION_ID_LINE_RE = /(?:julesSessionId|sessionId)\s*[:=]\s*["']?([A-Za-z0-9_-]+)/i;

export const JULES_SESSION_DOCUMENT_KEY = "jules-session";

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

export function formatJulesSessionHandleBody(sessionId: string, url?: string | null): string {
  return [
    `julesSessionId: ${sessionId}`,
    `url: ${julesSessionUrl(sessionId, url)}`,
  ].join("\n");
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
