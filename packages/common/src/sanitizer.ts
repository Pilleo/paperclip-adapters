const SENSITIVE_PATTERNS = [
  // Google AI Studio / API keys (AIza...)
  /\bAIza[A-Za-z0-9_-]{35}\b/g,
  // GitHub Personal Access Tokens & App tokens
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,255}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,
  // Generic URL embedded credentials (https://user:password@...)
  /https?:\/\/[^\s/@]+:[^\s/@]+@/gi,
];

export function redactSensitiveData(input: unknown): string {
  if (input === null || input === undefined) return "";
  let text = typeof input === "string" ? input : (input instanceof Error ? input.message : JSON.stringify(input));

  for (const pattern of SENSITIVE_PATTERNS) {
    text = text.replace(pattern, (match) => {
      if (match.startsWith("http")) {
        return match.replace(/:[^/@]+@/, ":[REDACTED]@");
      }
      return "[REDACTED]";
    });
  }

  return text;
}
