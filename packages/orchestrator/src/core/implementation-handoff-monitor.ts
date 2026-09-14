const REVISION_MONITOR_CADENCE_MS = 15 * 60 * 1000;
const REVISION_MONITOR_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/**
 * Narrows an opaque persisted execution policy to the exact monitor produced
 * above. This is deliberately structural, not prose-based: only the native
 * GitHub disposition owns the continuation-suppression path.
 */
export function isGitHubRevisionHandoffMonitor(policy: unknown): boolean {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
  const monitor = (policy as Record<string, unknown>)["monitor"];
  if (!monitor || typeof monitor !== "object" || Array.isArray(monitor)) return false;
  const record = monitor as Record<string, unknown>;
  return record["kind"] === "external_service"
    && record["serviceName"] === "github"
    && record["recoveryPolicy"] === "wake_owner"
    && record["maxAttempts"] === 1
    && typeof record["externalRef"] === "string";
}

/**
 * Native Paperclip disposition for a worker that has been asked to revise an
 * existing PR. It prevents generic successful-run recovery from launching a
 * second model turn while the orchestrator waits for GitHub's immutable head
 * and CI state. This is an adapters-only compatibility bridge until Paperclip
 * can atomically record a worker's declared PR handoff with its run result.
 */
export function buildGitHubRevisionMonitor(input: {
  readonly issueId: string;
  readonly pullRequestUrl: string;
  readonly headSha: string;
  readonly feedbackId: string;
  readonly now: number;
}): Record<string, unknown> {
  if (!Number.isFinite(input.now)) throw new Error("GitHub revision monitor requires a finite timestamp");
  return {
    mode: "normal",
    stages: [],
    monitor: {
      nextCheckAt: new Date(input.now + REVISION_MONITOR_CADENCE_MS).toISOString(),
      timeoutAt: new Date(input.now + REVISION_MONITOR_TIMEOUT_MS).toISOString(),
      notes: `Await GitHub PR revision for ${input.issueId} at ${input.headSha} after structured feedback ${input.feedbackId}.`,
      scheduledBy: "board",
      kind: "external_service",
      serviceName: "github",
      externalRef: input.pullRequestUrl,
      recoveryPolicy: "wake_owner",
      maxAttempts: 1,
    },
  };
}
