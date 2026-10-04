import { describe, expect, it } from "vitest";
import { prReviewChildDescription, prReviewChildKey, parsePrReviewChildDescription,
  ensurePrReviewChild, bootstrapPrReviewChild, activatePrReviewChild, observePrReviewChild,
  projectPrChildVerdict, isPrReviewChild } from "../src/core/pr-review-child.js";
import { shouldHoldLegacyParentPrCard } from "../src/core/pr-review-child.js";
import { inspectPrReviewChildren } from "../src/core/pr-review-child.js";
import { hasCompletedNativeApprovalLadderForHead, reviewVerdictFromInteraction } from "../src/core/review-interaction-state.js";

const luna = { version: 1 as const, companyId: "company", parentIssueId: "parent",
  prUrl: "https://github.com/Pilleo/fixture/pull/7", headSha: "a".repeat(40),
  stage: "luna" as const, reviewerAgentId: "luna", bootstrapAgentId: "orchestrator" };

describe("versioned issue-scoped PR review child identity", () => {
  it("refuses an invented answered child verdict at the parent projection boundary", () => {
    expect(() => projectPrChildVerdict(luna, {
      kind: "answered", childId: "child", cardId: "card", reviewerRunId: "run", verdict: "approve",
    } as never)).toThrow("verified native provenance");
  });
  it("round-trips a PR/head/reviewer-bound child and separates the strong stage", () => {
    const description = prReviewChildDescription(luna);
    expect(parsePrReviewChildDescription(description)).toEqual(luna);
    expect(prReviewChildKey(luna)).toMatch(/^pr-review:child:v1:[0-9a-f]{64}$/);
    expect(prReviewChildKey({ ...luna, stage: "strong", reviewerAgentId: "gemini" })).not.toBe(prReviewChildKey(luna));
    expect(prReviewChildKey({ ...luna, headSha: "b".repeat(40) })).not.toBe(prReviewChildKey(luna));
  });

  it("binds v2 board-origin children to their distinct issue-scoped orchestrator bootstrap", () => {
    const board = { ...luna, version: 2 as const, creatorPrincipal: "board" as const };
    const description = prReviewChildDescription(board as never);
    expect(parsePrReviewChildDescription(description)).toEqual(board);
    expect(prReviewChildKey(board as never)).toMatch(/^pr-review:child:v2:[0-9a-f]{64}$/);
    expect(isPrReviewChild({ companyId: "company", parentId: "parent", createdByAgentId: null,
      description })).toBe(true);
    expect(isPrReviewChild({ companyId: "company", parentId: "parent", createdByAgentId: "orchestrator",
      description })).toBe(false);
    expect(isPrReviewChild({ companyId: "company", parentId: "parent", createdByAgentId: null,
      description: prReviewChildDescription(luna) })).toBe(false);
  });

  it("rejects a mismatched descriptor, same-principal review, and noncanonical PR URL", () => {
    expect(parsePrReviewChildDescription("Review this PR")).toBeNull();
    expect(parsePrReviewChildDescription(prReviewChildDescription(luna).replace('"stage":"luna"', '"stage":"unknown"'))).toBeNull();
    expect(() => prReviewChildKey({ ...luna, reviewerAgentId: "orchestrator" })).toThrow();
    expect(() => prReviewChildKey({ ...luna, prUrl: "https://example.com/pull/7" })).toThrow();
  });
  it("isolates only a matching PR child from ordinary managed task scheduling", () => {
    const task = { companyId: "company", parentId: "parent", createdByAgentId: "orchestrator",
      description: prReviewChildDescription(luna) };
    expect(isPrReviewChild(task)).toBe(true);
    expect(isPrReviewChild({ ...task, createdByAgentId: "luna" })).toBe(false);
    expect(isPrReviewChild({ ...task, parentId: "another" })).toBe(false);
    expect(isPrReviewChild({ ...task, description: "Review this PR" })).toBe(false);
  });
  it("holds an unassigned board-created parent PR card for typed withdrawal instead of another Luna wake", () => {
    const card = { id: "pending-b", kind: "request_item_verdicts", status: "pending",
      createdByAgentId: null, addresseeAgentId: "luna",
      idempotencyKey: `pr-review:v13:parent:${luna.prUrl}:${luna.headSha}:luna` };
    const input = { issueId: "parent", status: "in_review", assigneeAgentId: null,
      prUrl: luna.prUrl, headSha: luna.headSha, workProductSource: "jules", cards: [card] };
    expect(shouldHoldLegacyParentPrCard(input)).toBe(true);
    expect(shouldHoldLegacyParentPrCard({ ...input, cards: [{ ...card, status: "cancelled" }] })).toBe(false);
    expect(shouldHoldLegacyParentPrCard({ ...input, workProductSource: "other" })).toBe(false);
  });

  it("creates exactly one backlog child only for the registered immutable head on an unassigned in-review parent", async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const api = { get: async (path: string) => {
      if (path === "/issues/parent") return { id: "parent", companyId: "company", status: "in_review", assigneeAgentId: null };
      if (path === "/issues/parent/work-products") return [{ url: luna.prUrl, type: "pull_request", isPrimary: true,
        status: "ready_for_review", metadata: { headSha: luna.headSha } }];
      if (path === "/issues/parent/interactions" || path.startsWith("/companies/company/issues?")) return [];
      throw new Error(`unexpected GET ${path}`);
    }, post: async (path: string, body: unknown) => {
      posts.push({ path, body });
      return { id: "review-child", companyId: "company", parentId: "parent", createdByAgentId: "orchestrator",
        assigneeAgentId: "orchestrator", description: (body as { description: string }).description, status: "backlog" };
    }, patch: async () => { throw new Error("PR child creation may not mutate the parent or reviewer"); } };
    expect(await ensurePrReviewChild({ identity: luna, api })).toBe("review-child");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.path).toBe("/issues/parent/children");
    expect(parsePrReviewChildDescription((posts[0]?.body as { description: string }).description)).toEqual(luna);
    expect(posts[0]?.body).toMatchObject({ status: "backlog", assigneeAgentId: "orchestrator",
      blockParentUntilDone: false });
  });

  it("refuses a replacement child while the original native parent PR card is pending", async () => {
    let created = 0;
    const api = { get: async (path: string) => {
      if (path === "/issues/parent") return { id: "parent", companyId: "company", status: "in_review", assigneeAgentId: null };
      if (path === "/issues/parent/work-products") return [{ url: luna.prUrl, type: "pull_request", isPrimary: true,
        status: "ready_for_review", metadata: { headSha: luna.headSha } }];
      if (path === "/issues/parent/interactions") return [{ kind: "request_item_verdicts", status: "pending",
        idempotencyKey: `pr-review:v13:parent:${luna.prUrl}:${luna.headSha}:luna` }];
      if (path.startsWith("/companies/company/issues?")) return [];
      throw new Error(`unexpected GET ${path}`);
    }, post: async () => { created++; return {}; }, patch: async () => { throw new Error("unexpected patch"); } };
    await expect(ensurePrReviewChild({ identity: luna, api })).rejects.toThrow(/parent.*card|pending/i);
    expect(created).toBe(0);
  });

  it.each(["idle", "error"])("bootstraps the addressed PR card with reviewer status %s on its own child-scoped run", async (status) => {
    const writes: Array<{ method: string; path: string; body: unknown }> = [];
    const api = { get: async (path: string) => {
      if (path === "/issues/parent") return { id: "parent", companyId: "company", status: "in_review", assigneeAgentId: null };
      if (path === "/issues/parent/work-products") return [{ url: luna.prUrl, type: "pull_request", isPrimary: true,
        status: "ready_for_review", metadata: { headSha: luna.headSha } }];
      if (path === "/issues/child") return { id: "child", companyId: "company", parentId: "parent", status: "in_progress",
        assigneeAgentId: "orchestrator", createdByAgentId: "orchestrator", description: prReviewChildDescription(luna) };
      if (path === "/issues/child/interactions") return [];
      if (path === "/agents/luna") return { id: "luna", companyId: "company", status };
      if (path === "/heartbeat-runs/bootstrap-run") return { id: "bootstrap-run", agentId: "orchestrator",
        companyId: "company", status: "running", contextSnapshot: { issueId: "child" } };
      throw new Error(`unexpected GET ${path}`);
    }, post: async (path: string, body: unknown) => { writes.push({ method: "POST", path, body });
      return { ...(body as object), id: "card-1", status: "pending", sourceRunId: "bootstrap-run" }; },
    patch: async (path: string, body: unknown) => { writes.push({ method: "PATCH", path, body });
      return { id: "child", companyId: "company", status: "backlog", assigneeAgentId: "orchestrator" }; } };
    expect(await bootstrapPrReviewChild({ identity: luna, childId: "child", agentId: "orchestrator",
      runId: "bootstrap-run", api })).toEqual({ kind: "card", cardId: "card-1" });
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ method: "POST", path: "/issues/child/interactions",
      body: { kind: "request_item_verdicts", idempotencyKey: expect.stringMatching(/^pr-review:v13:child:/),
        addresseeAgentId: "luna", payload: { items: [{ id: "pull_request" }] } } });
    expect(writes[1]).toEqual({ method: "PATCH", path: "/issues/child", body: { status: "backlog" } });
  });

  it.each(["paused", "terminated", "pending_approval"])("parks a child without spending its PR card when reviewer admission is %s", async (status) => {
    const writes: Array<{ path: string; body: unknown }> = [];
    const api = { get: async (path: string) => {
      if (path === "/issues/parent") return { id: "parent", companyId: "company", status: "in_review", assigneeAgentId: null };
      if (path === "/issues/parent/work-products") return [{ url: luna.prUrl, type: "pull_request", isPrimary: true,
        status: "ready_for_review", metadata: { headSha: luna.headSha } }];
      if (path === "/issues/child") return { id: "child", companyId: "company", parentId: "parent", status: "in_progress",
        assigneeAgentId: "orchestrator", createdByAgentId: "orchestrator", description: prReviewChildDescription(luna) };
      if (path === "/issues/child/interactions") return [];
      if (path === "/agents/luna") return { id: "luna", companyId: "company", status };
      if (path === "/heartbeat-runs/bootstrap-run") return { id: "bootstrap-run", companyId: "company",
        agentId: "orchestrator", status: "running", contextSnapshot: { issueId: "child" } };
      throw new Error(`unexpected GET ${path}`);
    }, post: async (path: string) => { throw new Error(`native card was spent while paused at ${path}`); },
    patch: async (path: string, body: unknown) => { writes.push({ path, body });
      return { id: "child", companyId: "company", status: "backlog", assigneeAgentId: "orchestrator" }; } };
    expect(await bootstrapPrReviewChild({ identity: luna, childId: "child", agentId: "orchestrator",
      runId: "bootstrap-run", api })).toEqual({ kind: "reviewer_unavailable", childId: "child", reviewerId: "luna" });
    expect(writes).toEqual([{ path: "/issues/child", body: { status: "backlog" } }]);
  });

  it.each(["idle", "error"])("activates a settled scoped card when reviewer status is %s", async (status) => {
    const patches: unknown[] = [];
    const api = { get: async (path: string) => {
      if (path === "/issues/child") return { id: "child", companyId: "company", parentId: "parent", status: "backlog",
        assigneeAgentId: "orchestrator", createdByAgentId: "orchestrator", description: prReviewChildDescription(luna) };
      if (path === "/issues/child/interactions") return [{ id: "card-1", kind: "request_item_verdicts", status: "pending",
        sourceRunId: "bootstrap-run", addresseeAgentId: "luna", idempotencyKey: `pr-review:v13:child:${luna.prUrl}:${luna.headSha}:luna` }];
      if (path === "/heartbeat-runs/bootstrap-run") return { id: "bootstrap-run", agentId: "orchestrator",
        companyId: "company", status: "succeeded", contextSnapshot: { issueId: "child" } };
      if (path === "/issues/child/runs") return [];
      if (path === "/agents/luna") return { id: "luna", companyId: "company", status };
      if (path === "/issues/parent") return { id: "parent", companyId: "company", status: "in_review", assigneeAgentId: null };
      if (path === "/issues/parent/work-products") return [{ url: luna.prUrl, type: "pull_request", isPrimary: true,
        status: "ready_for_review", metadata: { headSha: luna.headSha } }];
      throw new Error(`unexpected GET ${path}`);
    }, post: async () => { throw new Error("activation may not create another card"); },
    patch: async (path: string, body: unknown) => { patches.push({ path, body });
      return { id: "child", companyId: "company", status: "todo", assigneeAgentId: "luna" }; } };
    expect(await activatePrReviewChild({ identity: luna, childId: "child", api })).toBe("activated");
    expect(patches).toEqual([{ path: "/issues/child", body: { status: "todo", assigneeAgentId: "luna" } }]);
  });

  it("does not assign a parked PR child to a reviewer paused after its card was created", async () => {
    let assignments = 0;
    const api = { get: async (path: string) => {
      if (path === "/issues/parent") return { id: "parent", companyId: "company", status: "in_review", assigneeAgentId: null };
      if (path === "/issues/parent/work-products") return [{ url: luna.prUrl, type: "pull_request", isPrimary: true,
        status: "ready_for_review", metadata: { headSha: luna.headSha } }];
      if (path === "/issues/child") return { id: "child", companyId: "company", parentId: "parent", status: "backlog",
        assigneeAgentId: "orchestrator", createdByAgentId: "orchestrator", description: prReviewChildDescription(luna) };
      if (path === "/issues/child/interactions") return [{ id: "card-1", kind: "request_item_verdicts", status: "pending",
        sourceRunId: "bootstrap-run", addresseeAgentId: "luna", idempotencyKey: `pr-review:v13:child:${luna.prUrl}:${luna.headSha}:luna` }];
      if (path === "/heartbeat-runs/bootstrap-run") return { id: "bootstrap-run", companyId: "company",
        agentId: "orchestrator", status: "succeeded", contextSnapshot: { issueId: "child" } };
      if (path === "/issues/child/runs") return [];
      if (path === "/agents/luna") return { id: "luna", companyId: "company", status: "paused" };
      throw new Error(`unexpected GET ${path}`);
    }, post: async () => { throw new Error("activation may not post"); },
    patch: async () => { assignments++; return {}; } };
    expect(await activatePrReviewChild({ identity: luna, childId: "child", api })).toBe("waiting");
    expect(assignments).toBe(0);
  });

  it.each([["in_review", "approve", "valid"], ["blocked", "reject", "valid"],
    ["in_review", "approve", "foreign-bootstrap-id"], ["in_review", "approve", "foreign-reviewer-id"]] as const)(
    "attributes a %s Luna child %s with %s run identity", async (parentStatus, verdict, provenance) => {
    const api = { get: async (path: string) => {
      if (path === "/issues/parent") return { id: "parent", companyId: "company", status: parentStatus,
        assigneeAgentId: parentStatus === "blocked" ? "jules" : null };
      if (path === "/issues/parent/work-products") return [{ url: luna.prUrl, type: "pull_request", isPrimary: true,
        status: "ready_for_review", metadata: { headSha: luna.headSha } }];
      if (path === "/issues/child") return { id: "child", companyId: "company", parentId: "parent", status: "in_progress",
        createdByAgentId: "orchestrator", assigneeAgentId: "luna", description: prReviewChildDescription(luna) };
      if (path === "/issues/child/interactions") return [{ id: "card-1", kind: "request_item_verdicts", status: "answered",
        idempotencyKey: `pr-review:v13:child:${luna.prUrl}:${luna.headSha}:luna`, addresseeAgentId: "luna",
        sourceRunId: "bootstrap-run", resolvedByAgentId: "luna", resolvedByRunId: "reviewer-run",
        result: { outcome: "resolved", complete: true, items: [{ id: "pull_request", verdict,
          ...(verdict === "reject" ? { reason: "Fractional inputs must throw TypeError." } : {}) }] } }];
      if (path === "/heartbeat-runs/bootstrap-run") return { id: provenance === "foreign-bootstrap-id" ? "another-run" : "bootstrap-run", companyId: "company",
        agentId: "orchestrator", status: "succeeded", contextSnapshot: { issueId: "child" } };
      if (path === "/heartbeat-runs/reviewer-run") return { id: provenance === "foreign-reviewer-id" ? "another-run" : "reviewer-run", companyId: "company",
        agentId: "luna", status: "succeeded", contextSnapshot: { issueId: "child" } };
      throw new Error(`unexpected GET ${path}`);
    }, post: async () => { throw new Error("verdict observation must be read-only"); },
    patch: async () => { throw new Error("verdict observation must be read-only"); } };
    if (provenance !== "valid") {
      await expect(observePrReviewChild({ identity: luna, childId: "child", api })).rejects.toThrow("provenance");
      return;
    }
    expect(await observePrReviewChild({ identity: luna, childId: "child", api,
      allowRemediationStatus: parentStatus === "blocked" })).toMatchObject({
      kind: "answered", childId: "child", cardId: "card-1", reviewerRunId: "reviewer-run", verdict,
      ...(verdict === "reject" ? { reason: "Fractional inputs must throw TypeError." } : {}),
    });
  });

  it("makes only validated child verdicts readable by the existing parent-scoped native review reducer", async () => {
    const verified = async (identity: typeof luna | (Omit<typeof luna, "stage"> & { stage: "strong" }),
      childId: string, cardId: string, runId: string) => {
      const api = { get: async (route: string) => {
        if (route === "/issues/parent") return { id: "parent", companyId: "company", status: "in_review", assigneeAgentId: null };
        if (route === "/issues/parent/work-products") return [{ url: identity.prUrl, type: "pull_request",
          isPrimary: true, status: "ready_for_review", metadata: { headSha: identity.headSha } }];
        if (route === `/issues/${childId}`) return { id: childId, companyId: "company", parentId: "parent",
          createdByAgentId: "orchestrator", assigneeAgentId: identity.reviewerAgentId, status: "done",
          description: prReviewChildDescription(identity) };
        if (route === `/issues/${childId}/interactions`) return [{ id: cardId, kind: "request_item_verdicts", status: "answered",
          idempotencyKey: `pr-review:v13:${childId}:${identity.prUrl}:${identity.headSha}:${identity.stage}`,
          addresseeAgentId: identity.reviewerAgentId, sourceRunId: `bootstrap-${childId}`, resolvedByRunId: runId,
          result: { outcome: "resolved", complete: true, items: [{ id: "pull_request", verdict: "approve" }] } }];
        if (route === `/heartbeat-runs/bootstrap-${childId}`) return { id: `bootstrap-${childId}`, companyId: "company",
          agentId: "orchestrator", status: "succeeded", contextSnapshot: { issueId: childId } };
        if (route === `/heartbeat-runs/${runId}`) return { id: runId, companyId: "company", agentId: identity.reviewerAgentId,
          status: "succeeded", contextSnapshot: { issueId: childId } };
        throw new Error(`Unexpected native evidence GET ${route}`);
      }, post: async () => { throw new Error("Observation must remain read-only"); },
      patch: async () => { throw new Error("Observation must remain read-only"); } };
      const result = await observePrReviewChild({ identity, childId, api });
      if (result.kind !== "answered") throw new Error("Native review fixture did not resolve");
      return result;
    };
    const lunaProof = await verified(luna, "luna-child", "luna-card", "luna-run");
    const first = projectPrChildVerdict(luna, lunaProof);
    const strongIdentity = { ...luna, stage: "strong" as const, reviewerAgentId: "gemini" };
    const strong = projectPrChildVerdict(strongIdentity, await verified(strongIdentity, "strong-child", "strong-card", "gemini-run"));
    expect(() => projectPrChildVerdict({ ...luna, headSha: "b".repeat(40) }, lunaProof)).toThrow("verified native provenance");
    expect(() => projectPrChildVerdict(luna, { ...lunaProof } as never)).toThrow("verified native provenance");
    expect(reviewVerdictFromInteraction(first, "luna-card")).toEqual({ decision: "all_good" });
    expect(hasCompletedNativeApprovalLadderForHead([first, strong], "parent", luna.headSha, undefined, "strong", "gemini"))
      .toBe(true);
    expect(first.idempotencyKey).toContain(`:parent:${luna.prUrl}:${luna.headSha}:luna`);
    expect(strong.idempotencyKey).toContain(`:parent:${luna.prUrl}:${luna.headSha}:strong`);
  });

  it("advances to the strong stage only after the distinct Luna child verdict is attested", async () => {
    const child = { id: "luna-child", companyId: "company", parentId: "parent", status: "in_progress",
      assigneeAgentId: "luna", createdByAgentId: "orchestrator", description: prReviewChildDescription(luna) };
    const api = { get: async (path: string) => {
      if (path === "/companies/company/issues?limit=1000&parentId=parent") return [child];
      if (path === "/issues/parent") return { id: "parent", companyId: "company", status: "in_review", assigneeAgentId: null };
      if (path === "/issues/parent/work-products") return [{ url: luna.prUrl, type: "pull_request", isPrimary: true,
        status: "ready_for_review", metadata: { headSha: luna.headSha } }];
      if (path === "/issues/luna-child") return child;
      if (path === "/issues/luna-child/interactions") return [{ id: "luna-card", kind: "request_item_verdicts", status: "answered",
        idempotencyKey: `pr-review:v13:luna-child:${luna.prUrl}:${luna.headSha}:luna`, addresseeAgentId: "luna",
        sourceRunId: "bootstrap-run", resolvedByAgentId: "luna", resolvedByRunId: "reviewer-run",
        result: { outcome: "resolved", complete: true, items: [{ id: "pull_request", verdict: "approve" }] } }];
      if (path === "/heartbeat-runs/bootstrap-run") return { id: "bootstrap-run", companyId: "company",
        agentId: "orchestrator", status: "succeeded", contextSnapshot: { issueId: "luna-child" } };
      if (path === "/heartbeat-runs/reviewer-run") return { id: "reviewer-run", companyId: "company",
        agentId: "luna", status: "succeeded", contextSnapshot: { issueId: "luna-child" } };
      throw new Error(`unexpected GET ${path}`);
    }, post: async () => { throw new Error("inspection must not write"); },
    patch: async () => { throw new Error("inspection must not write"); } };
    const result = await inspectPrReviewChildren({ companyId: "company", parentIssueId: "parent",
      prUrl: luna.prUrl, headSha: luna.headSha, bootstrapAgentId: "orchestrator",
      lunaAgentId: "luna", strongAgentId: "gemini", api });
    expect(result).toMatchObject({ kind: "dispatch", stage: "strong", reviewerAgentId: "gemini" });
    if (result.kind === "dispatch") {
      expect(result.projections).toHaveLength(1);
      expect(reviewVerdictFromInteraction(result.projections[0], "luna-card")).toEqual({ decision: "all_good" });
    }
  });
});
