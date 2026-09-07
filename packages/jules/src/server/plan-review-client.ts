import { createHash } from "node:crypto";
import { getPaperclipJson, PaperclipIssue, INTERNAL_REVIEW_EXECUTION_POLICY } from "./paperclip-client.js";
import { paperclipRequestForInternalUse } from "./paperclip-review-internal.js";

export async function createJulesPlanReviewChild(
  parentIssueId: string, reviewerAgentId: string, stage: "vibe" | "strong",
  plan: string, revisionId: string, authToken: string | undefined, runId?: string, companyId?: string,
): Promise<PaperclipIssue> {
  const fingerprint = createHash("sha256").update(`${parentIssueId}:${revisionId}:${stage}`).digest("hex").slice(0, 24);
  const marker = `<!-- jules-plan-review:${fingerprint} -->`;
  const delegation = `<!-- paperclip-delegation kind=jules-plan-review parent=${parentIssueId} revision=${revisionId} stage=${stage} fingerprint=${fingerprint} -->`;
  if (companyId) {
    const raw = await getPaperclipJson<unknown>(`/api/companies/${encodeURIComponent(companyId)}/issues?limit=1000`, authToken, runId).catch(() => []);
    const list = Array.isArray(raw) ? raw : ((raw as { issues?: unknown[] })?.issues ?? []);
    const existing = list.find((v) => {
      const i = v as Record<string, unknown>;
      return i["parentId"] === parentIssueId &&
        typeof i["description"] === "string" && (i["description"] as string).includes(marker);
    });
    if (existing && typeof (existing as Record<string, unknown>)["id"] === "string") {
      const existingIssue = existing as PaperclipIssue;
      // Lookup is deliberately side-effect free. In particular, do not reset
      // blocked/in_progress/in_review/done children: their status is the
      // review state machine's durable progress, not an orphan to reclaim.
      return existingIssue;
    }
  }
  const instruction = stage === "vibe"
    ? `Return PASS_TO_STRONG when the plan is coherent, or REQUEST_REVISION for concrete issues. Never ask a human.`
    : `Return APPROVE when the plan is implementable, REQUEST_REVISION for concrete fixes, or ESCALATE only when a human decision is genuinely missing.`;
  const body = `${delegation}\n${marker}\nYou are the ${stage === "vibe" ? "fast" : "strong"} ACP reviewer for a Jules implementation plan. ${instruction}\n\nPlan:\n${plan}\n\nPost exactly one raw JSON comment (no Markdown fence). The parent Jules worker consumes that comment as the completion event; do not ask for a human response and do not rely on changing the issue status.\n${stage === "vibe" ? '{"kind":"PASS_TO_STRONG","summary":"..."}' : '{"kind":"APPROVE","summary":"..."}'}\nor {"kind":"REQUEST_REVISION","findings":["..."],"questions":[]}\nor {"kind":"ESCALATE","reason":"..."}`;
  // Jules owns the plan gate. Do not make the Paperclip tree dependency own
  // it too: Paperclip may route a blocked child through its generic review
  // recovery and prevent the parent from resuming even after a valid ACP
  // decision comment exists. The child remains an auditable ACP work item;
  // Jules' persisted session is the authoritative parent gate.
  const response = await paperclipRequestForInternalUse(`/api/issues/${encodeURIComponent(parentIssueId)}/children`, authToken, {
    method: "POST", body: JSON.stringify({ title: `Review Jules plan (${stage})`, description: body, status: "todo", priority: "high", assigneeAgentId: reviewerAgentId, blockParentUntilDone: false, executionPolicy: INTERNAL_REVIEW_EXECUTION_POLICY }),
  }, runId);
  const created = await response.json() as PaperclipIssue;
  // Paperclip versions predating child-assignee support can inherit the
  // parent's owner. Assignment is an explicit post-create compatibility
  // operation; it is never performed on an existing child above and never
  // changes its status.
  if (created.id) {
    await paperclipRequestForInternalUse(`/api/issues/${encodeURIComponent(created.id)}`, authToken, {
      method: "PATCH", body: JSON.stringify({ assigneeAgentId: reviewerAgentId, blockParentUntilDone: false, executionPolicy: INTERNAL_REVIEW_EXECUTION_POLICY }),
    }, runId).catch(() => undefined);
  }
  return created;
}
