import { describe, expect, it, vi } from "vitest";
import { nativePlanReviewStageId, childPlanReviewDescription, childPlanReviewKey } from "@pilleo/paperclip-adapter-common";
import {
  reconcileAnsweredPlanReviewHandback,
  readPlanReviewAssignmentAndReconcileHandback,
  submitPlanVerdictAndReturnToJules,
} from "../src/core/native-plan-review-handback.js";

const issueId = "issue-1";
const lunaId = "luna-1";
const julesId = "jules-1";
const cardId = "plan-card-1";
const revisionId = "revision-1";
const stageId = nativePlanReviewStageId(issueId, revisionId, "luna");
const key = `jules:plan-review:v2:${issueId}:session-1:${revisionId}:luna`;

const issue = {
  id: issueId,
  status: "in_review",
  assigneeAgentId: lunaId,
  executionPolicy: {
    stages: [{ id: stageId, type: "review", participants: [{ type: "agent", agentId: lunaId }] }],
  },
  executionState: {
    status: "pending", currentStageId: stageId, currentStageType: "review",
    currentParticipant: { type: "agent", agentId: lunaId },
    returnAssignee: { type: "agent", agentId: julesId },
  },
};
const card = {
  id: cardId, status: "answered", kind: "request_item_verdicts", addresseeAgentId: lunaId,
  idempotencyKey: key, resolvedByAgentId: lunaId, resolvedByRunId: "luna-run-1", sourceRunId: "jules-run-1",
  payload: {
    items: [{ id: "plan", label: "Plan" }],
    target: { type: "issue_document", issueId, documentId: "doc-1", key: "plan", revisionId, revisionNumber: 1 },
  },
  result: { outcome: "resolved", complete: true, items: [{ id: "plan", verdict: "approve" }] },
};

function fixture(overrides: {
  readonly issue?: Record<string, unknown>;
  readonly card?: Record<string, unknown>;
  readonly document?: Record<string, unknown>;
  readonly run?: Record<string, unknown>;
} = {}) {
  const writes: { body?: string; path?: string }[] = [];
  const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === "PATCH") {
      writes.push({ path, body: String(init.body) });
      return new Response(JSON.stringify({ id: issueId, status: "in_progress", assigneeAgentId: julesId }), { status: 200 });
    }
    const value = path === `/api/issues/${issueId}` ? overrides.issue ?? issue
      : path === `/api/issues/${issueId}/interactions` ? [overrides.card ?? card]
      : path === `/api/issues/${issueId}/documents/plan`
        ? overrides.document ?? { id: "doc-1", latestRevisionId: revisionId, latestRevisionNumber: 1 }
      : path === "/api/heartbeat-runs/luna-run-1"
          ? overrides.run ?? { id: "luna-run-1", agentId: lunaId, contextSnapshot: { issueId, interactionId: cardId } }
          : path === "/api/heartbeat-runs/jules-run-1"
            ? { id: "jules-run-1", agentId: julesId, contextSnapshot: { issueId } }
          : null;
    if (value === null) throw new Error(`Unexpected GET ${path}`);
    return new Response(JSON.stringify(value), { status: 200 });
  });
  return { fetcher, writes };
}

const input = {
  apiBase: "http://127.0.0.1:3100", issueId, agentId: lunaId,
  interactionId: cardId, token: "reviewer-jwt", runId: "luna-recovery-run-2",
} as const;

describe("native Jules plan-review handback", () => {
  it("returns an exact reviewer-attributed typed plan verdict to the Jules owner", async () => {
    const { fetcher, writes } = fixture();
    const result = await reconcileAnsweredPlanReviewHandback({ ...input, fetcher });
    expect(result).toEqual({ ok: true, interactionId: cardId, reviewer: "luna", verdict: "approve", disposition: "returned_to_jules" });
    expect(writes).toEqual([{ path: `/api/issues/${issueId}`, body: JSON.stringify({ executionPolicy: null }) }]);
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining(`/api/issues/${issueId}`), expect.objectContaining({
      method: "PATCH", headers: expect.objectContaining({ Authorization: "Bearer reviewer-jwt", "X-Paperclip-Run-Id": "luna-recovery-run-2" }),
    }));
  });

  it("returns an answered card resolved by the exact native stage run without an interactionId context", async () => {
    const { fetcher, writes } = fixture({ run: {
      id: "luna-run-1", agentId: lunaId, companyId: "company-1", status: "succeeded",
      contextSnapshot: {
        issueId,
        executionStage: {
          wakeRole: "reviewer", stageId, stageType: "review",
          currentParticipant: { type: "agent", agentId: lunaId },
          returnAssignee: { type: "agent", agentId: julesId },
        },
      },
    } });
    expect(await reconcileAnsweredPlanReviewHandback({ ...input, fetcher })).toEqual({
      ok: true, interactionId: cardId, reviewer: "luna", verdict: "approve", disposition: "returned_to_jules",
    });
    expect(writes).toHaveLength(1);
  });

  it("refuses a native stage run bound to a different review stage", async () => {
    const { fetcher, writes } = fixture({ run: {
      id: "luna-run-1", agentId: lunaId,
      contextSnapshot: { issueId, executionStage: {
        wakeRole: "reviewer", stageId: "foreign-stage", stageType: "review",
        currentParticipant: { type: "agent", agentId: lunaId },
        returnAssignee: { type: "agent", agentId: julesId },
      } },
    } });
    expect(await reconcileAnsweredPlanReviewHandback({ ...input, fetcher })).toEqual({ ok: false, code: "untrusted_plan_verdict" });
    expect(writes).toEqual([]);
  });

  it("does not reassign an issue for an answered card resolved by another actor", async () => {
    const { fetcher, writes } = fixture({ card: { ...card, resolvedByAgentId: "board-actor", resolvedByRunId: null } });
    expect(await reconcileAnsweredPlanReviewHandback({ ...input, fetcher })).toEqual({ ok: false, code: "untrusted_plan_verdict" });
    expect(writes).toEqual([]);
  });

  it("refuses a handback without an authenticated reviewer credential", async () => {
    const { fetcher, writes } = fixture();
    expect(await reconcileAnsweredPlanReviewHandback({ ...input, token: undefined, fetcher })).toEqual({ ok: false, code: "invalid_identity" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("refuses a run receipt whose reviewer or interaction binding differs", async () => {
    const { fetcher, writes } = fixture({ run: { id: "luna-run-1", agentId: "terra-1", contextSnapshot: { issueId, interactionId: cardId } } });
    expect(await reconcileAnsweredPlanReviewHandback({ ...input, fetcher })).toEqual({ ok: false, code: "untrusted_plan_verdict" });
    expect(writes).toEqual([]);
  });

  it("requires a concrete rejection reason before returning the issue", async () => {
    const { fetcher, writes } = fixture({ card: { ...card, result: { outcome: "resolved", complete: true, items: [{ id: "plan", verdict: "reject" }] } } });
    expect(await reconcileAnsweredPlanReviewHandback({ ...input, fetcher })).toEqual({ ok: false, code: "invalid_card_evidence" });
    expect(writes).toEqual([]);
  });

  it("does not return ownership after the plan document advanced to another revision", async () => {
    const { fetcher, writes } = fixture({ document: { id: "doc-1", latestRevisionId: "revision-2", latestRevisionNumber: 2 } });
    expect(await reconcileAnsweredPlanReviewHandback({ ...input, fetcher })).toEqual({ ok: false, code: "stale_plan_revision" });
    expect(writes).toEqual([]);
  });

  it("does not erase an existing multistage execution policy", async () => {
    const { fetcher, writes } = fixture({ issue: {
      ...issue, executionPolicy: { stages: [...issue.executionPolicy.stages, { id: "stage-2", type: "review", participants: [{ type: "agent", agentId: "terra-1" }] }] },
    } });
    expect(await reconcileAnsweredPlanReviewHandback({ ...input, fetcher })).toEqual({ ok: false, code: "unowned_review_policy" });
    expect(writes).toEqual([]);
  });

  it("does not erase an unrelated one-stage review policy", async () => {
    const { fetcher, writes } = fixture({ issue: {
      ...issue, executionPolicy: { stages: [{ ...issue.executionPolicy.stages[0], id: "unrelated-stage" }] },
      executionState: { ...issue.executionState, currentStageId: "unrelated-stage" },
    } });
    expect(await reconcileAnsweredPlanReviewHandback({ ...input, fetcher })).toEqual({ ok: false, code: "unowned_review_policy" });
    expect(writes).toEqual([]);
  });

  it("observes the already-completed handback without replaying the PATCH", async () => {
    const { fetcher, writes } = fixture({ issue: { ...issue, status: "in_progress", assigneeAgentId: julesId, executionPolicy: null, executionState: null } });
    expect(await reconcileAnsweredPlanReviewHandback({ ...input, fetcher })).toEqual({
      ok: true, interactionId: cardId, reviewer: "luna", verdict: "approve", disposition: "already_returned",
    });
    expect(writes).toEqual([]);
  });

  it("reconciles an answered stage-bound card during assignment lookup after a reviewer restart", async () => {
    const { fetcher, writes } = fixture({ run: {
      id: "luna-run-1", agentId: lunaId, contextSnapshot: { issueId, executionStage: {
        wakeRole: "reviewer", stageId, stageType: "review",
        currentParticipant: { type: "agent", agentId: lunaId },
        returnAssignee: { type: "agent", agentId: julesId },
      } },
    } });
    const result = await readPlanReviewAssignmentAndReconcileHandback({ ...input, fetcher });
    expect(result).toEqual({ ok: true, assignment: {
      kind: "plan_handback_recovered", interactionId: cardId, verdict: "approve",
    } });
    expect(writes).toEqual([{ path: `/api/issues/${issueId}`, body: JSON.stringify({ executionPolicy: null }) }]);
  });

  it("submits a pending plan verdict and returns the issue before reporting success", async () => {
    const pending = { id: cardId, kind: "request_item_verdicts", status: "pending", addresseeAgentId: lunaId, payload: { items: [{ id: "plan" }] } };
    let interactionsCalls = 0;
    const writes: string[] = [];
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "PATCH") {
        writes.push(String(init?.body));
        return new Response(JSON.stringify({ id: issueId, status: "in_progress", assigneeAgentId: julesId }), { status: 200 });
      }
      if (path === `/api/issues/${issueId}/interactions` && method === "GET") {
        interactionsCalls += 1;
        return new Response(JSON.stringify([interactionsCalls === 1 ? pending : card]), { status: 200 });
      }
      if (path === `/api/issues/${issueId}/interactions/${cardId}/verdicts`) {
        return new Response(JSON.stringify({ id: cardId, status: "answered", result: { items: [{ id: "plan", verdict: "approve" }] } }), { status: 200 });
      }
      if (path === `/api/issues/${issueId}`) return new Response(JSON.stringify(issue), { status: 200 });
      if (path === `/api/issues/${issueId}/documents/plan`) {
        return new Response(JSON.stringify({ id: "doc-1", latestRevisionId: revisionId, latestRevisionNumber: 1 }), { status: 200 });
      }
      if (path === "/api/heartbeat-runs/luna-run-1") {
        return new Response(JSON.stringify({ id: "luna-run-1", agentId: lunaId, contextSnapshot: { issueId, interactionId: cardId } }), { status: 200 });
      }
      if (path === "/api/heartbeat-runs/jules-run-1") {
        return new Response(JSON.stringify({ id: "jules-run-1", agentId: julesId, contextSnapshot: { issueId } }), { status: 200 });
      }
      throw new Error(`Unexpected ${method} ${path}`);
    });

    const result = await submitPlanVerdictAndReturnToJules({
      apiBase: "http://127.0.0.1:3100", issueId, agentId: lunaId, interactionId: cardId,
      token: "reviewer-jwt", runId: "luna-recovery-run-2", verdict: "approve", fetcher,
    });

    expect(result).toEqual({ ok: true, interactionId: cardId, itemId: "plan", verdict: "approve" });
    expect(writes).toEqual([JSON.stringify({ executionPolicy: null })]);
  });

  it("recovers the handback when a reviewer restarts after the verdict response is lost", async () => {
    const writes: string[] = [];
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (method === "PATCH") {
        writes.push(String(init?.body));
        return new Response(JSON.stringify({ id: issueId, status: "in_progress", assigneeAgentId: julesId }), { status: 200 });
      }
      if (path === `/api/issues/${issueId}/interactions`) return new Response(JSON.stringify([card]), { status: 200 });
      if (path === `/api/issues/${issueId}`) return new Response(JSON.stringify(issue), { status: 200 });
      if (path === `/api/issues/${issueId}/documents/plan`) {
        return new Response(JSON.stringify({ id: "doc-1", latestRevisionId: revisionId, latestRevisionNumber: 1 }), { status: 200 });
      }
      if (path === "/api/heartbeat-runs/luna-run-1") {
        return new Response(JSON.stringify({ id: "luna-run-1", agentId: lunaId, contextSnapshot: { issueId, interactionId: cardId } }), { status: 200 });
      }
      if (path === "/api/heartbeat-runs/jules-run-1") {
        return new Response(JSON.stringify({ id: "jules-run-1", agentId: julesId, contextSnapshot: { issueId } }), { status: 200 });
      }
      throw new Error(`Unexpected ${method} ${path}`);
    });

    const result = await submitPlanVerdictAndReturnToJules({
      apiBase: "http://127.0.0.1:3100", issueId, agentId: lunaId, interactionId: cardId,
      token: "reviewer-jwt", runId: "luna-recovery-run-2", verdict: "approve", fetcher,
    });

    expect(result).toEqual({ ok: true, interactionId: cardId, itemId: "plan", verdict: "approve" });
    expect(writes).toEqual([JSON.stringify({ executionPolicy: null })]);
  });

  it("leaves pull-request verdicts untouched by plan handback", async () => {
    const prCard = { id: cardId, kind: "request_item_verdicts", status: "pending", addresseeAgentId: lunaId, payload: { items: [{ id: "pull_request" }] } };
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (path === `/api/issues/${issueId}/interactions`) return new Response(JSON.stringify([prCard]), { status: 200 });
      if (method === "POST") {
        return new Response(JSON.stringify({ id: cardId, status: "answered", result: { items: [{ id: "pull_request", verdict: "approve" }] } }), { status: 200 });
      }
      throw new Error(`Unexpected ${method} ${path}`);
    });

    const result = await submitPlanVerdictAndReturnToJules({
      apiBase: "http://127.0.0.1:3100", issueId, agentId: lunaId, interactionId: cardId,
      token: "reviewer-jwt", runId: "luna-recovery-run-2", verdict: "approve", fetcher,
    });

    expect(result).toEqual({ ok: true, interactionId: cardId, itemId: "pull_request", verdict: "approve" });
  });

  it("submits a v3 child plan verdict without attempting any ownership handback", async () => {
    const paths: string[] = [];
    const identity = { version: 3 as const, companyId: "co", parentIssueId: "parent", sessionId: "session",
      activityId: "activity", documentId: "doc", revisionId: "revision", revisionNumber: 1, stage: "luna" as const,
      reviewerAgentId: lunaId, bootstrapAgentId: "orch", julesAgentId: julesId };
    const fetcher = async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      paths.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/interactions")) return new Response(JSON.stringify([{
        id: cardId, kind: "request_item_verdicts", status: "pending", addresseeAgentId: lunaId,
        idempotencyKey: childPlanReviewKey(identity),
        payload: { items: [{ id: "plan" }], target: { type: "issue_document", issueId: "parent", documentId: "doc",
          key: "plan", revisionId: "revision", revisionNumber: 1 } },
      }]), { status: 200 });
      if (path.endsWith("/verdicts")) return new Response(JSON.stringify({ id: cardId, status: "answered",
        result: { items: [{ id: "plan", verdict: "approve" }] } }), { status: 200 });
      if (path === `/api/issues/${issueId}` && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        expect(body.status).toBe("done");
        expect(body.assigneeAgentId).toBeUndefined();
        return new Response(JSON.stringify({ id: issueId, status: "done", assigneeAgentId: lunaId }), { status: 200 });
      }
      if (path === `/api/issues/${issueId}`) return new Response(JSON.stringify({ id: issueId, companyId: "co",
        parentId: "parent", createdByAgentId: julesId, assigneeAgentId: lunaId, status: "in_progress",
        description: childPlanReviewDescription(identity), executionPolicy: null, executionState: null,
      }), { status: 200 });
      throw new Error(`Unexpected child handback request ${path}`);
    };
    expect(await submitPlanVerdictAndReturnToJules({ ...input, fetcher, verdict: "approve" })).toMatchObject({
      ok: true, interactionId: cardId, verdict: "approve", planReviewProtocol: "child_v3",
    });
    expect(paths).toHaveLength(4);
  });

  it("reports a failed plan handback instead of claiming verdict success", async () => {
    const { fetcher } = fixture({ issue: {
      ...issue, executionPolicy: { stages: [...issue.executionPolicy.stages, { id: "stage-2", type: "review", participants: [{ type: "agent", agentId: "terra-1" }] }] },
    } });
    const pending = { id: cardId, kind: "request_item_verdicts", status: "pending", addresseeAgentId: lunaId, payload: { items: [{ id: "plan" }] } };
    let interactionsCalls = 0;
    const composed = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (path === `/api/issues/${issueId}/interactions` && method === "GET") {
        interactionsCalls += 1;
        return new Response(JSON.stringify([interactionsCalls === 1 ? pending : card]), { status: 200 });
      }
      if (path === `/api/issues/${issueId}/interactions/${cardId}/verdicts`) {
        return new Response(JSON.stringify({ id: cardId, status: "answered", result: { items: [{ id: "plan", verdict: "approve" }] } }), { status: 200 });
      }
      return fetcher(String(url), init);
    });

    const result = await submitPlanVerdictAndReturnToJules({
      apiBase: "http://127.0.0.1:3100", issueId, agentId: lunaId, interactionId: cardId,
      token: "reviewer-jwt", runId: "luna-recovery-run-2", verdict: "approve", fetcher: composed,
    });

    expect(result).toEqual({ ok: false, code: "unowned_review_policy" });
  });
});
