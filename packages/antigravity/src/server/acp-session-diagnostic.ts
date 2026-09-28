export interface AcpSessionErrorDiagnostic {
  readonly code: number;
  readonly fields: readonly string[];
  readonly types: readonly string[];
}

const SAFE_FIELDS = new Set([
  "cwd", "mcpServers", "headers", "name", "url", "type", "value", "_meta", "env", "command", "args",
]);

/** Extract validation locations from a caught ACP RequestError without retaining input or messages. */
export function diagnoseAcpSessionError(error: unknown): AcpSessionErrorDiagnostic | null {
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const failure = error as Record<string, unknown>;
  if (failure["code"] !== -32602) return null;
  const data = failure["data"];
  const issues = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)["errors"] : null;
  const fields: string[] = [];
  const types: string[] = [];
  if (Array.isArray(issues)) {
    for (const issue of issues.slice(0, 8)) {
      if (!issue || typeof issue !== "object" || Array.isArray(issue)) continue;
      const item = issue as Record<string, unknown>;
      const loc = item["loc"];
      if (!Array.isArray(loc) || !loc.length || loc.length > 8 ||
          !loc.every((part) => typeof part === "string" ? SAFE_FIELDS.has(part) :
            typeof part === "number" && Number.isInteger(part) && part >= 0 && part < 100)) continue;
      fields.push(loc.map((part, index) => typeof part === "number" ? `[${part}]` :
        `${index > 0 ? "." : ""}${part}`).join(""));
      const type = item["type"];
      types.push(typeof type === "string" && /^[a-z_]{1,40}$/.test(type) ? type : "unknown");
    }
  }
  return { code: -32602, fields, types };
}
