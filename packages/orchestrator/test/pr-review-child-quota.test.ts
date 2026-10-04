import { describe, expect, it } from "vitest";
import { ensurePrReviewChild, inspectPrReviewChildren, isPrReviewChild, prReviewChildDescription,
  prReviewChildKey, bootstrapPrReviewChild, observePrReviewChild } from "../src/core/pr-review-child.js";

const identity = { version: 2 as const, creatorPrincipal: "board" as const, companyId: "company",
  parentIssueId: "parent", prUrl: "https://github.com/Pilleo/fixture/pull/21", headSha: "a".repeat(40),
  stage: "luna" as const, reviewerAgentId: "luna", bootstrapAgentId: "orchestrator" };
const title = `Review pull request (luna) [${prReviewChildKey(identity)}]`;

function fixture(failure = Object.assign(new Error("Parent issue already has the maximum 25 child issues for this helper"), { status: 422 })) {
  const historical = Array.from({ length: 25 }, (_, i) => ({ id: `old-${i}`, companyId: "company",
    parentId: "parent", status: "cancelled", description: "Historical helper" }));
  const helpers: Array<Record<string, unknown>> = [];
  const cards: Array<Record<string, unknown>> = [];
  const writes: string[] = [];
  const api = {
    get: async (path: string): Promise<unknown> => {
      if (path === "/issues/parent") return { id: "parent", companyId: "company", projectId: "project",
        status: "in_review", assigneeAgentId: null };
      if (path === "/issues/parent/work-products") return [{ type: "pull_request", isPrimary: true,
        status: "ready_for_review", url: identity.prUrl, metadata: { headSha: identity.headSha } }];
      if (path === "/issues/parent/interactions") return [];
      if (path.includes("parentId=")) return historical;
      if (path.startsWith("/companies/company/issues?")) return [...historical, ...helpers];
      if (path === "/issues/helper") return helpers[0];
      if (path === "/issues/helper/interactions") return cards;
      if (path === "/heartbeat-runs/bootstrap") return { id: "bootstrap", companyId: "company",
        agentId: "orchestrator", status: cards.length ? "succeeded" : "running", contextSnapshot: { issueId: "helper" } };
      if (path === "/heartbeat-runs/reviewer") return { id: "reviewer", companyId: "company",
        agentId: "luna", status: "succeeded", contextSnapshot: { issueId: "helper" } };
      if (path === "/agents/luna") return { id: "luna", companyId: "company", status: "idle" };
      throw new Error(`Unexpected GET ${path}`);
    },
    post: async (path: string, body: unknown): Promise<unknown> => {
      writes.push(path);
      if (path === "/issues/parent/children") throw failure;
      if (path === "/companies/company/issues") {
        const child = { ...(body as object), id: "helper", companyId: "company", parentId: null, createdByAgentId: null };
        helpers.push(child); return child;
      }
      if (path === "/issues/helper/interactions") {
        const card = { ...(body as object), id: "card", status: "pending", sourceRunId: "bootstrap" };
        cards.push(card); return card;
      }
      throw new Error(`Unexpected POST ${path}`);
    },
    patch: async (path: string, body: unknown): Promise<unknown> => {
      if (path !== "/issues/helper") throw new Error("May not patch the source");
      Object.assign(helpers[0]!, body); return helpers[0];
    },
  };
  return { api, helpers, cards, writes };
}

describe("PR reviewer helper quota recovery", () => {
  it("creates a correlated standalone reviewer only after the exact helper quota rejection and reuses it", async () => {
    const f = fixture();
    expect(await ensurePrReviewChild({ identity, api: f.api })).toBe("helper");
    expect(f.helpers[0]).toMatchObject({ title, projectId: "project", parentId: null,
      status: "backlog", assigneeAgentId: "orchestrator" });
    expect(isPrReviewChild(f.helpers[0])).toBe(true);
    expect(await ensurePrReviewChild({ identity, api: f.api })).toBe("helper");
    expect(f.writes.filter(p => p === "/companies/company/issues")).toHaveLength(1);
    expect(await inspectPrReviewChildren({ ...identity, lunaAgentId: "luna", strongAgentId: "strong",
      protocolVersion: 2, api: f.api })).toMatchObject({ kind: "bootstrap", childId: "helper" });
  });

  it("requires the same child-scoped bootstrap and exact reviewer run for a standalone verdict", async () => {
    const f = fixture();
    await ensurePrReviewChild({ identity, api: f.api });
    expect(await bootstrapPrReviewChild({ identity, childId: "helper", agentId: "orchestrator",
      runId: "bootstrap", api: f.api })).toEqual({ kind: "card", cardId: "card" });
    Object.assign(f.helpers[0]!, { status: "done", assigneeAgentId: "luna" });
    Object.assign(f.cards[0]!, { status: "answered", resolvedByAgentId: "luna", resolvedByRunId: "reviewer",
      result: { outcome: "resolved", complete: true, items: [{ id: "pull_request", verdict: "approve" }] } });
    expect(await observePrReviewChild({ identity, childId: "helper", api: f.api })).toMatchObject({ kind: "answered", verdict: "approve" });
    expect(await inspectPrReviewChildren({ ...identity, lunaAgentId: "luna", strongAgentId: "strong",
      protocolVersion: 2, api: f.api })).toMatchObject({ kind: "dispatch", stage: "strong", projections: [{ id: "card" }] });
    f.helpers[0]!["createdByAgentId"] = "other";
    await expect(observePrReviewChild({ identity, childId: "helper", api: f.api })).rejects.toThrow("identity or author");
  });

  it.each([Object.assign(new Error("Permission denied"), { status: 403 }),
    Object.assign(new Error("maximum 25 child issues"), { status: 500 }),
    Object.assign(new Error("another validation error"), { status: 422 })])("propagates unrelated creation failures", async (failure) => {
    const f = fixture(failure);
    await expect(ensurePrReviewChild({ identity, api: f.api })).rejects.toBe(failure);
    expect(f.helpers).toHaveLength(0);
  });

  it("rejects an uncorrelated standalone title or altered creator", () => {
    const child = { id: "helper", companyId: "company", parentId: null, createdByAgentId: null,
      title, description: prReviewChildDescription(identity), status: "backlog" };
    expect(isPrReviewChild(child)).toBe(true);
    expect(isPrReviewChild({ ...child, title: "ordinary task" })).toBe(false);
    expect(isPrReviewChild({ ...child, createdByAgentId: "other" })).toBe(false);
  });

  it("recovers an accepted standalone creation after its response is lost without another POST", async () => {
    const f = fixture();
    const post = f.api.post;
    f.api.post = async (path, body) => {
      const receipt = await post(path, body);
      if (path === "/companies/company/issues") throw new Error("accepted response lost");
      return receipt;
    };
    await expect(ensurePrReviewChild({ identity, api: f.api })).rejects.toThrow("accepted response lost");
    expect(await ensurePrReviewChild({ identity, api: f.api })).toBe("helper");
    expect(f.writes.filter(p => p === "/companies/company/issues")).toHaveLength(1);
  });

  it("fails closed on duplicated standalone identities", async () => {
    const f = fixture();
    await ensurePrReviewChild({ identity, api: f.api });
    f.helpers.push({ ...f.helpers[0], id: "duplicate" });
    await expect(ensurePrReviewChild({ identity, api: f.api })).rejects.toThrow("Duplicate PR review");
    await expect(inspectPrReviewChildren({ ...identity, lunaAgentId: "luna", strongAgentId: "strong",
      protocolVersion: 2, api: f.api })).rejects.toThrow("Multiple native PR");
  });
});
