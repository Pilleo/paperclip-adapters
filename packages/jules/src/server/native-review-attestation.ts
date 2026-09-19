/**
 * Paperclip v2026.831.1 records an MCP reviewer verdict under the local board
 * principal even though its native-review gateway executed it for the assigned
 * agent.  The interaction row alone therefore cannot distinguish the reviewer
 * decision from a board override.  This adapter-only verifier accepts that
 * compatibility gap only when Paperclip's own immutable heartbeat result has
 * an exact structured MCP receipt for the addressed issue/card/verdict.
 *
 * Remove this once Paperclip persists `resolvedByAgentId` for native MCP
 * verdicts and exposes an agent-only resolver policy for review cards.
 */
export function hasNativeReviewVerdictAttestation(input: {
  readonly reviewerAgentId: string;
  /** The issue that owns both the addressed native card and reviewer run. */
  readonly reviewerIssueId: string;
  readonly interactionId: string;
  readonly verdict: "approve" | "reject";
  readonly runs: readonly unknown[];
}): boolean {
  return input.runs.some((run) => isExactReviewerRun(run, input));
}

function isExactReviewerRun(run: unknown, input: {
  readonly reviewerAgentId: string;
  readonly reviewerIssueId: string;
  readonly interactionId: string;
  readonly verdict: "approve" | "reject";
}): boolean {
  if (!isRecord(run) || run["agentId"] !== input.reviewerAgentId || run["status"] !== "succeeded") return false;
  const context = record(run["contextSnapshot"]);
  if (context?.["taskId"] !== input.reviewerIssueId && context?.["issueId"] !== input.reviewerIssueId) return false;
  const result = record(run["resultJson"]);
  if (!result || typeof result["stdout"] !== "string") return false;
  return result["stdout"].split("\n").some((line) => isExactVerdictEvent(line, input));
}

function isExactVerdictEvent(line: string, input: { readonly interactionId: string; readonly verdict: "approve" | "reject" }): boolean {
  if (!line.trim()) return false;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return false;
  }
  const event = record(value);
  const item = event && record(event["item"]);
  if (!item || item["type"] !== "mcp_tool_call" || item["server"] !== "paperclip_review" ||
      item["tool"] !== "submit_native_review_verdict" || item["status"] !== "completed") return false;
  const result = record(item["result"]);
  const receipt = result && record(result["structured_content"]);
  return receipt?.["interactionId"] === input.interactionId && receipt["verdict"] === input.verdict;
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
