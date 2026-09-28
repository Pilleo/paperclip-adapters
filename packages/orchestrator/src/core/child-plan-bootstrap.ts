import { bootstrapChildPlanReview, CHILD_PLAN_REVIEW_PREFIX, parseChildPlanReviewDescription, ReviewerUnavailableError } from "@pilleo/paperclip-adapter-common";
import { nativeReviewFetch } from "./native-review-http.js";

/** Only the addressed reviewer's exact host pause is a retryable wait. */
export function classifyUnavailableReviewer(status: number, body: unknown, reviewerId: string): ReviewerUnavailableError | null {
  if (status !== 422 || typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const details = record["details"];
  if (record["error"] !== "addresseeAgentId must reference an invokable agent" ||
      typeof details !== "object" || details === null || Array.isArray(details)) return null;
  const fields = details as Record<string, unknown>;
  return fields["reason"] === "paused" && fields["agentId"] === reviewerId
    ? new ReviewerUnavailableError(reviewerId) : null;
}

/** Special issue-scoped execution: never uses the scheduler's local-board write fallback. */
export async function executeChildPlanBootstrap(input: {
  readonly apiBase: string; readonly issueId: string; readonly agentId: string; readonly runId: string;
  readonly token: string | undefined; readonly description: unknown;
}): Promise<{ readonly childId: string; readonly cardId: string } |
  { readonly kind: "reviewer_unavailable"; readonly childId: string; readonly reviewerId: string } | null> {
  if (typeof input.description !== "string" || !input.description.startsWith(CHILD_PLAN_REVIEW_PREFIX)) return null;
  const identity = parseChildPlanReviewDescription(input.description);
  if (!identity || identity.bootstrapAgentId !== input.agentId || !input.token || !input.runId) {
    throw new Error("Invalid authenticated child-plan bootstrap context");
  }
  const base = input.apiBase.replace(/\/+$/, "").replace(/\/api$/, "");
  const request = async (path: string, method: string, body?: unknown): Promise<unknown> => {
    const response = await nativeReviewFetch(`${base}/api${path}`, { method,
      headers: { Authorization: `Bearer ${input.token}`, "X-Paperclip-Run-Id": input.runId, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const raw = await response.text();
      if (method === "POST" && path.endsWith("/interactions")) {
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { parsed = null; }
        const unavailable = classifyUnavailableReviewer(response.status, parsed, identity.reviewerAgentId);
        if (unavailable) throw unavailable;
      }
      throw new Error(`Child-plan bootstrap ${method} ${path} failed (${response.status})`);
    }
    return response.json();
  };
  return bootstrapChildPlanReview({ identity, childId: input.issueId, agentId: input.agentId, runId: input.runId,
    api: { get: (path) => request(path, "GET"), post: (path, body) => request(path, "POST", body), patch: (path, body) => request(path, "PATCH", body) } });
}
