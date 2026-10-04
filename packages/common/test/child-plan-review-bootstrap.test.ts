import { describe, expect, it } from "vitest";
import { bootstrapChildPlanReview, ReviewerUnavailableError } from "../src/child-plan-review-bootstrap.js";
import { childPlanReviewDescription, childPlanReviewKey, type ChildPlanReviewIdentity } from "../src/child-plan-review.js";

const identity: ChildPlanReviewIdentity = { version: 3, companyId: "company", parentIssueId: "parent", sessionId: "session",
  activityId: "activity", documentId: "document", revisionId: "revision", revisionNumber: 1,
  stage: "luna", reviewerAgentId: "luna", bootstrapAgentId: "orchestrator", julesAgentId: "jules" };
function fixture(overrides: Record<string, unknown> = {}) {
  const writes: { path: string; body: unknown }[] = [];
  const data: Record<string, unknown> = {
    "/issues/child": { id: "child", companyId: "company", parentId: "parent", assigneeAgentId: "orchestrator",
      createdByAgentId: "jules", status: "in_progress", description: childPlanReviewDescription(identity),
      executionPolicy: { stages: [], commentRequired: false } },
    "/issues/parent": { id: "parent", companyId: "company", assigneeAgentId: "jules", status: "in_progress" },
    "/issues/parent/documents/plan": { id: "document", latestRevisionId: "revision", latestRevisionNumber: 1, latestBody: "# Plan" },
    "/agents/luna": { id: "luna", companyId: "company", status: "idle" },
    "/heartbeat-runs/bootstrap-run": { id: "bootstrap-run", companyId: "company", agentId: "orchestrator", status: "running", contextSnapshot: { issueId: "child" } },
    "/issues/child/interactions": [], ...overrides,
  };
  return { writes, api: {
    get: async (path: string) => { if (!(path in data)) throw new Error(`Unexpected GET ${path}`); return data[path]; },
    post: async (path: string, body: unknown) => { writes.push({ path, body }); return { ...(body as object), id: "card", status: "pending", sourceRunId: "bootstrap-run" }; },
    patch: async (path: string, body: unknown) => { writes.push({ path, body }); return { ...(data[path] as object), ...(body as object) }; },
  } };
}

describe("child-scoped native card bootstrap", () => {
  it("keeps plan-card bootstrap valid while its exact parent session waits on a native Jules question", async () => {
    const { api } = fixture({
      "/issues/parent": { id: "parent", companyId: "company", assigneeAgentId: "jules", status: "blocked", executionBlocker: null },
      "/issues/parent/interactions": [{ kind: "ask_user_questions", status: "pending", sourceRunId: "parent-run",
        idempotencyKey: "jules:agent-adjudication:parent:session:question:presentation:v2" }],
      "/heartbeat-runs/parent-run": { id: "parent-run", companyId: "company", agentId: "jules", status: "succeeded", contextSnapshot: { issueId: "parent" } },
    });
    expect(await bootstrapChildPlanReview({ identity, childId: "child", agentId: "orchestrator", runId: "bootstrap-run", api })).toMatchObject({ cardId: "card" });
  });

  it("does not reinterpret an execution failure as a question wait", async () => {
    const { api, writes } = fixture({
      "/issues/parent": { id: "parent", companyId: "company", assigneeAgentId: "jules", status: "blocked", executionBlocker: { kind: "legacy_execution_requires_reconciliation" } },
      "/issues/parent/interactions": [],
    });
    await expect(bootstrapChildPlanReview({ identity, childId: "child", agentId: "orchestrator", runId: "bootstrap-run", api })).rejects.toThrow(/ownership|hold/);
    expect(writes).toEqual([]);
  });
  it("accepts the host's normalized null policy on a bootstrap-owned child", async () => {
    const { api } = fixture();
    const get = api.get;
    const patch = api.patch;
    api.get = async (path) => path === "/issues/child" ? { ...(await get(path) as object), executionPolicy: null } : get(path);
    api.patch = async (path, body) => ({ ...(await patch(path, body) as object), executionPolicy: null });
    expect(await bootstrapChildPlanReview({ identity, childId: "child", agentId: "orchestrator", runId: "bootstrap-run", api })).toEqual({ childId: "child", cardId: "card" });
  });
  it("creates the addressed card under the child run and parks only the child", async () => {
    const { api, writes } = fixture();
    expect(await bootstrapChildPlanReview({ identity, childId: "child", agentId: "orchestrator", runId: "bootstrap-run", api }))
      .toEqual({ childId: "child", cardId: "card" });
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ path: "/issues/child/interactions", body: {
      idempotencyKey: childPlanReviewKey(identity), addresseeAgentId: "luna", continuationPolicy: "none",
      payload: { target: { issueId: "parent", revisionId: "revision" } },
    } });
    expect(writes[1]).toEqual({ path: "/issues/child", body: { status: "backlog" } });
  });

  it("parks the same child without a verdict card while the reviewer is paused", async () => {
    const { api, writes } = fixture({ "/agents/luna": { id: "luna", companyId: "company", status: "paused" } });
    expect(await bootstrapChildPlanReview({ identity, childId: "child", agentId: "orchestrator", runId: "bootstrap-run", api }))
      .toEqual({ kind: "reviewer_unavailable", childId: "child", reviewerId: "luna" });
    expect(writes).toEqual([{ path: "/issues/child", body: { status: "backlog" } }]);
  });
  it("creates a fresh scoped card despite an unrelated prior-run reviewer error", async () => {
    const { api, writes } = fixture({ "/agents/luna": { id: "luna", companyId: "company", status: "error" } });
    expect(await bootstrapChildPlanReview({ identity, childId: "child", agentId: "orchestrator", runId: "bootstrap-run", api }))
      .toEqual({ childId: "child", cardId: "card" });
    expect(writes[0]).toMatchObject({ path: "/issues/child/interactions" });
  });
  it.each(["terminated", "pending_approval"])("parks the child while reviewer admission is %s", async (status) => {
    const { api, writes } = fixture({ "/agents/luna": { id: "luna", companyId: "company", status } });
    expect(await bootstrapChildPlanReview({ identity, childId: "child", agentId: "orchestrator", runId: "bootstrap-run", api }))
      .toEqual({ kind: "reviewer_unavailable", childId: "child", reviewerId: "luna" });
    expect(writes).toEqual([{ path: "/issues/child", body: { status: "backlog" } }]);
  });
  it("parks the child when the reviewer pauses after the readiness read but before card POST", async () => {
    const { api, writes } = fixture();
    api.post = async () => { throw new ReviewerUnavailableError("luna"); };
    expect(await bootstrapChildPlanReview({ identity, childId: "child", agentId: "orchestrator", runId: "bootstrap-run", api }))
      .toEqual({ kind: "reviewer_unavailable", childId: "child", reviewerId: "luna" });
    expect(writes).toEqual([{ path: "/issues/child", body: { status: "backlog" } }]);
  });

  it("refuses parent-scoped bootstrap credentials before creating a card", async () => {
    const { api, writes } = fixture({ "/heartbeat-runs/bootstrap-run": { id: "bootstrap-run", companyId: "company",
      agentId: "orchestrator", status: "running", contextSnapshot: { issueId: "parent" } } });
    await expect(bootstrapChildPlanReview({ identity, childId: "child", agentId: "orchestrator", runId: "bootstrap-run", api })).rejects.toThrow(/run/);
    expect(writes).toEqual([]);
  });

  it("refuses a revised parent plan before creating a card", async () => {
    const { api, writes } = fixture({ "/issues/parent/documents/plan": { id: "document", latestRevisionId: "new", latestRevisionNumber: 2 } });
    await expect(bootstrapChildPlanReview({ identity, childId: "child", agentId: "orchestrator", runId: "bootstrap-run", api })).rejects.toThrow(/revision/);
    expect(writes).toEqual([]);
  });
  it("reuses a persisted card after a lost creation response", async () => {
    const { api, writes } = fixture({ "/issues/child/interactions": [{ id: "existing", status: "pending", kind: "request_item_verdicts",
      idempotencyKey: childPlanReviewKey(identity), addresseeAgentId: "luna", sourceRunId: "bootstrap-run" }] });
    expect(await bootstrapChildPlanReview({ identity, childId: "child", agentId: "orchestrator", runId: "bootstrap-run", api }))
      .toEqual({ childId: "child", cardId: "existing" });
    expect(writes).toEqual([{ path: "/issues/child", body: { status: "backlog" } }]);
  });
});
