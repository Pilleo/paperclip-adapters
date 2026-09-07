/**
 * Paperclip projects a native monitor into executionState while a run is
 * executing. That projection can survive a terminal adapter result, so it is
 * not authoritative ownership of provider work. Only executionPolicy is the
 * durable input the orchestrator can safely reattach.
 */
export function isAuthoritativeJulesMonitor(executionPolicy: unknown): boolean {
  if (!executionPolicy || typeof executionPolicy !== "object" || Array.isArray(executionPolicy)) return false;
  const monitor = (executionPolicy as Record<string, unknown>)["monitor"];
  if (!monitor || typeof monitor !== "object" || Array.isArray(monitor)) return false;
  const record = monitor as Record<string, unknown>;
  return record["serviceName"] === "jules" && typeof record["externalRef"] === "string" && (record["externalRef"] as string).trim().length > 0;
}

export function canPromoteJulesPrToReview(input: {
  readonly ciGreen: boolean;
  readonly currentHeadRejected: boolean;
  readonly executionPolicy?: unknown;
}): boolean {
  return input.ciGreen && !input.currentHeadRejected && !isAuthoritativeJulesMonitor(input.executionPolicy);
}
