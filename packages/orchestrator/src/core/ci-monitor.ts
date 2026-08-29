export interface CiCheckItem {
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string;
  readonly state?: string;
}

export interface EvaluatedCiStatus {
  readonly state: "PENDING" | "SUCCESS" | "FAILURE" | "UNKNOWN";
  readonly commitSha: string;
  readonly failedChecks: readonly string[];
  readonly totalChecks: number;
}

export function evaluatePrCiChecks(
  commitSha: string,
  checks: readonly CiCheckItem[] = []
): EvaluatedCiStatus {
  if (!checks || checks.length === 0) {
    return {
      state: "UNKNOWN",
      commitSha,
      failedChecks: [],
      totalChecks: 0,
    };
  }

  const failed: string[] = [];
  let hasPending = false;

  for (const c of checks) {
    const name = c.name || "check";
    const conclusion = (c.conclusion || c.state || "").toUpperCase();
    const status = (c.status || "").toUpperCase();

    if (conclusion === "FAILURE" || conclusion === "TIMED_OUT" || conclusion === "STARTUP_FAILURE" || conclusion === "ACTION_REQUIRED") {
      failed.push(name);
    } else if (status === "IN_PROGRESS" || status === "QUEUED" || conclusion === "PENDING") {
      hasPending = true;
    }
  }

  if (failed.length > 0) {
    return {
      state: "FAILURE",
      commitSha,
      failedChecks: Object.freeze(failed),
      totalChecks: checks.length,
    };
  }

  if (hasPending) {
    return {
      state: "PENDING",
      commitSha,
      failedChecks: Object.freeze([]),
      totalChecks: checks.length,
    };
  }

  return {
    state: "SUCCESS",
    commitSha,
    failedChecks: Object.freeze([]),
    totalChecks: checks.length,
  };
}

export function formatCiAlertComment(prNumber: number, prUrl: string, ci: EvaluatedCiStatus): string {
  const failedList = ci.failedChecks.map((f) => `- ❌ \`${f}\``).join("\n");
  return `### ⚠️ CI Checks Failed on [PR #${prNumber}](${prUrl})\n\n**Commit:** \`${ci.commitSha.slice(0, 7)}\`\n**Failed Checks (${ci.failedChecks.length}/${ci.totalChecks}):**\n${failedList}\n\n<!-- mazewall:ci-failure-sha=${ci.commitSha} -->`;
}
