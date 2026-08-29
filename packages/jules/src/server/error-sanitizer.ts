export function sanitizeError(error: unknown, config?: { maxLen?: number }): string {
  let msg = "Unknown error";
  if (error instanceof Error) {
    msg = error.message;
  } else if (typeof error === "string") {
    msg = error;
  } else if (error !== null && error !== undefined) {
    try {
      msg = JSON.stringify(error);
    } catch {
      msg = String(error);
    }
  }

  // Redact potential API keys (basic heuristic: strings that look like typical keys)
  // This is a simple regex that masks long alphanumeric strings that could be keys.
  // We can refine this if Jules keys have a specific format.
  msg = msg.replace(/(?:key|token|password|secret|auth|credential)["'=:\s]+([a-zA-Z0-9_\-]{16,})/gi, (match, keyGroup) => {
      return match.replace(keyGroup, '***REDACTED***');
  });

  const maxLen = config?.maxLen ?? 500;
  if (msg.length > maxLen) {
    msg = msg.substring(0, maxLen) + "... (truncated)";
  }

  return msg;
}
