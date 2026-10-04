import { describe, expect, it } from "vitest";
import { reconcileChildPlanReview } from "../src/child-plan-review-parent.js";
import { childPlanReviewDescription, childPlanReviewKey, type ChildPlanReviewIdentity } from "../src/child-plan-review.js";

const identity: ChildPlanReviewIdentity = { version: 3, companyId: "co", parentIssueId: "parent", sessionId: "session",
  activityId: "activity", documentId: "doc", revisionId: "rev", revisionNumber: 1, stage: "luna",
  reviewerAgentId: "luna", bootstrapAgentId: "orch", julesAgentId: "jules" };
const child = { id: "child", companyId: "co", parentId: "parent", createdByAgentId: "jules", status: "backlog",
  assigneeAgentId: "orch", description: childPlanReviewDescription(identity), executionBlocker: null };
const card = { id: "card", companyId: "co", issueId: "child", kind: "request_item_verdicts", status: "pending",
  idempotencyKey: childPlanReviewKey(identity), addresseeAgentId: "luna", sourceRunId: "bootstrap-run",
  payload: { target: { type: "issue_document", issueId: "parent", key: "plan", documentId: "doc", revisionId: "rev", revisionNumber: 1 } } };
function fixture(extra: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    "/issues/parent": { id: "parent", companyId: "co", status: "in_progress", assigneeAgentId: "jules" },
    "/issues/parent/documents/plan": { id: "doc", latestRevisionId: "rev", latestRevisionNumber: 1 },
    "/issues/child": child, "/issues/child/interactions": [card],
    "/agents/luna": { id: "luna", companyId: "co", status: "idle" },
    "/issues/child/runs": [{ runId: "bootstrap-run", status: "succeeded", agentId: "orch", contextIssueId: "child" }],
    "/heartbeat-runs/bootstrap-run": { id: "bootstrap-run", companyId: "co", agentId: "orch", status: "succeeded", contextSnapshot: { issueId: "child" } }, ...extra,
  };
  const writes: unknown[] = [];
  return { writes, api: { get: async (path: string) => { if (!(path in data)) throw new Error(`Unexpected ${path}`); return data[path]; },
    post: async (path: string, body: unknown) => { throw new Error(`Unexpected POST ${path}`); },
    patch: async (path: string, body: unknown) => { writes.push({ path, body }); return { ...child, ...(body as object) }; },
  } };
}
describe("Jules-owned child review coordination", () => {
  it("assigns only the bootstrapped child after its source run succeeds", async () => {
    const { api, writes } = fixture();
    expect(await reconcileChildPlanReview({ identity, childId: "child", api })).toEqual({ kind: "waiting", childId: "child" });
    expect(writes).toEqual([{ path: "/issues/child", body: { status: "todo", assigneeAgentId: "luna", blockParentUntilDone: false,
      executionPolicy: { mode: "normal", stages: [], commentRequired: false } } }]);
  });
  it("does not interrupt a running bootstrap", async () => {
    const { api, writes } = fixture({ "/issues/child/runs": [{ runId: "bootstrap-run", status: "running", agentId: "orch", contextIssueId: "child" }] });
    expect(await reconcileChildPlanReview({ identity, childId: "child", api })).toEqual({ kind: "waiting", childId: "child" });
    expect(writes).toEqual([]);
  });
  it("recovers an existing child from the parent even when the company issue index is full", async () => {
    const { api, writes } = fixture({ "/companies/co/issues?limit=1000&parentId=parent": [child] });
    expect(await reconcileChildPlanReview({ identity, api })).toEqual({ kind: "waiting", childId: "child" });
    expect(writes).toHaveLength(1);
  });
  it("recovers an existing child after losing its creation receipt", async () => {
    const { api, writes } = fixture({ "/companies/co/issues?limit=1000&parentId=parent": [child] });
    expect(await reconcileChildPlanReview({ identity, api })).toEqual({ kind: "waiting", childId: "child" });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: "/issues/child" });
  });
  it("refuses ambiguous child identities rather than creating another task", async () => {
    const { api, writes } = fixture({ "/companies/co/issues?limit=1000&parentId=parent": [child, { ...child, id: "duplicate" }] });
    await expect(reconcileChildPlanReview({ identity, api })).rejects.toThrow(/Duplicate/);
    expect(writes).toEqual([]);
  });
  it("rejects a stale parent revision before activating a reviewer", async () => {
    const { api, writes } = fixture({ "/issues/parent/documents/plan": { id: "doc", latestRevisionId: "new-revision", latestRevisionNumber: 2 } });
    await expect(reconcileChildPlanReview({ identity, childId: "child", api })).rejects.toThrow(/revision/);
    expect(writes).toEqual([]);
  });
  it("ignores unrelated orchestrator timer runs while checking child bootstrap settlement", async () => {
    const { api } = fixture({ "/issues/child/runs": [{ runId: "bootstrap-run", status: "succeeded", agentId: "orch", contextIssueId: "child" }] });
    expect(await reconcileChildPlanReview({ identity, childId: "child", api })).toEqual({ kind: "waiting", childId: "child" });
  });
  it("waits on the same child while its addressed reviewer remains paused", async () => {
    const { api, writes } = fixture({ "/issues/child/interactions": [], "/agents/luna": { id: "luna", companyId: "co", status: "paused" } });
    expect(await reconcileChildPlanReview({ identity, childId: "child", api })).toEqual({ kind: "waiting", childId: "child" });
    expect(writes).toEqual([]);
  });
  it("admits a deferred bootstrap after a reviewer's prior-run error", async () => {
    const { api, writes } = fixture({ "/issues/child/interactions": [],
      "/agents/luna": { id: "luna", companyId: "co", status: "error" } });
    await reconcileChildPlanReview({ identity, childId: "child", api });
    expect(writes).toMatchObject([{ path: "/issues/child", body: { status: "todo", assigneeAgentId: "orch" } }]);
  });
  it.each(["terminated", "pending_approval"])("preserves administrative %s admission holds", async (status) => {
    const { api, writes } = fixture({ "/issues/child/interactions": [],
      "/agents/luna": { id: "luna", companyId: "co", status } });
    await reconcileChildPlanReview({ identity, childId: "child", api });
    expect(writes).toEqual([]);
  });
  it("recovers the exact pending card after an unstarted reviewer queue row was cancelled", async () => {
    const { api, writes } = fixture({ "/issues/child": { ...child, status: "blocked", assigneeAgentId: "luna" },
      "/issues/child/runs": [{ runId: "cancelled-unstarted", status: "cancelled", agentId: "luna", contextIssueId: "child" }],
      "/heartbeat-runs/cancelled-unstarted": { id: "cancelled-unstarted", companyId: "co", agentId: "luna",
        status: "cancelled", startedAt: null, contextSnapshot: { issueId: "child" } } });
    expect(await reconcileChildPlanReview({ identity, childId: "child", api })).toEqual({ kind: "waiting", childId: "child" });
    expect(writes).toMatchObject([{ path: "/issues/child", body: { status: "todo", assigneeAgentId: "luna" } }]);
  });
  it("does not recover while an addressed reviewer run is scheduled for retry", async () => {
    const { api, writes } = fixture({ "/issues/child": { ...child, status: "blocked", assigneeAgentId: "luna" },
      "/issues/child/runs": [{ runId: "active", status: "scheduled_retry", agentId: "luna", contextIssueId: "child" }] });
    await reconcileChildPlanReview({ identity, childId: "child", api });
    expect(writes).toEqual([]);
  });
  it.each(["failed", "succeeded", "cancelled"])("does not replay a %s reviewer that started", async (status) => {
    const { api, writes } = fixture({ "/issues/child": { ...child, status: "blocked", assigneeAgentId: "luna" },
      "/issues/child/runs": [{ runId: "terminal", status, agentId: "luna", contextIssueId: "child" }],
      "/heartbeat-runs/terminal": { id: "terminal", companyId: "co", agentId: "luna", status,
        startedAt: "2026-10-04T00:00:00Z", contextSnapshot: { issueId: "child" } } });
    await expect(reconcileChildPlanReview({ identity, childId: "child", api })).rejects.toThrow(/terminal|unstarted/);
    expect(writes).toEqual([]);
  });
  it("requires a successfully settled source before idle pending-card recovery", async () => {
    const { api, writes } = fixture({ "/issues/child": { ...child, status: "blocked", assigneeAgentId: "luna" },
      "/issues/child/runs": [],
      "/heartbeat-runs/bootstrap-run": { id: "bootstrap-run", companyId: "co", agentId: "orch",
        status: "failed", contextSnapshot: { issueId: "child" } } });
    await expect(reconcileChildPlanReview({ identity, childId: "child", api })).rejects.toThrow(/source|bootstrap/);
    expect(writes).toEqual([]);
  });
  it("accepts a board-stamped reject bound to the reviewer run after child cleanup fails", async () => {
    const receipt = JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "paperclip_review", tool: "submit_native_review_verdict", status: "failed", result: { structured_content: { code: "child_plan_cleanup_failed" } } } });
    const { api, writes } = fixture({
      "/issues/child": { ...child, status: "done", assigneeAgentId: "luna" },
      "/issues/child/interactions": [{ ...card, status: "answered", resolvedByAgentId: null, resolvedByUserId: "local-board", resolvedByRunId: "review-run",
        result: { outcome: "resolved", complete: true, items: [{ id: "plan", verdict: "reject", reason: "revise the plan" }] } }],
      "/heartbeat-runs/review-run": { id: "review-run", companyId: "co", agentId: "luna", status: "succeeded", contextSnapshot: { issueId: "child" }, resultJson: { stdout: receipt } },
    });
    expect(await reconcileChildPlanReview({ identity, childId: "child", api })).toEqual({ kind: "answered", childId: "child", cardId: "card", verdict: "reject", reason: "revise the plan", reviewerRunId: "review-run" });
    expect(writes).toEqual([]);
  });
  it.each([null, { recoveryActionId: "post-verdict-cleanup-hold" }])("consumes the typed verdict independently of child cleanup hold %j", async (executionBlocker) => {
    const { api, writes } = fixture({ "/issues/child": { ...child, status: "in_progress", assigneeAgentId: "luna", executionBlocker },
      "/issues/child/interactions": [{ ...card, status: "answered", resolvedByAgentId: "luna", resolvedByRunId: "review-run",
        result: { outcome: "resolved", complete: true, items: [{ id: "plan", verdict: "approve" }] } }],
      "/heartbeat-runs/review-run": { id: "review-run", companyId: "co", agentId: "luna", status: "running", contextSnapshot: { issueId: "child" } },
    });
    expect(await reconcileChildPlanReview({ identity, childId: "child", api })).toEqual({ kind: "answered", childId: "child", cardId: "card", verdict: "approve", reviewerRunId: "review-run" });
    expect(writes).toEqual([]);
  });
});
