import { afterEach, describe, expect, it } from "vitest";
import * as recovery from "../src/core/conflict-recovery.js";
import { normalizeConflictRecoveryPolicy, selectConflictRecoveryAgent } from "../src/core/conflict-recovery.js";
import { createPaperclipHttp } from "../src/core/paperclip-http.js";

describe("conflict recovery policy", () => {
  it("keeps agent selection inert until automatic repair is explicitly enabled", () => {
    expect(normalizeConflictRecoveryPolicy({ conflictRecoveryAgentId: "chosen" })).toEqual({ mode: "manual" });
    expect(normalizeConflictRecoveryPolicy({ conflictRecoveryMode: "git_only", conflictRecoveryAgentId: "chosen" }))
      .toEqual({ mode: "git_only" });
    expect(normalizeConflictRecoveryPolicy({ conflictRecoveryMode: "agent", conflictRecoveryAgentId: " chosen " }))
      .toEqual({ mode: "agent", agentId: "chosen" });
  });

  it.each(["codex_local", "antigravity", "jules", "process", "custom_adapter"])(
    "selects the exact independent %s agent without adapter filtering", (adapterType) => {
      const chosen = { id: "chosen", companyId: "company", adapterType, name: "Independent reviewer", role: "qa" };
      expect(selectConflictRecoveryAgent("company", "chosen", [
        { id: "other", companyId: "company", adapterType: "process" }, chosen,
      ])).toBe(chosen);
    },
  );

  it("fails instead of substituting another agent for an absent or foreign resolver", () => {
    const agents = [{ id: "other", companyId: "company", adapterType: "process" },
      { id: "chosen", companyId: "foreign", adapterType: "jules" }];
    expect(() => selectConflictRecoveryAgent("company", "missing", agents)).toThrow();
    expect(() => selectConflictRecoveryAgent("company", "chosen", agents)).toThrow();
  });
});

describe("native conflict recovery", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  const prUrl = "https://github.com/acme/repo/pull/1";

  function fixture(adapterType = "process") {
    let product: Record<string, unknown> = { id: "product", type: "pull_request", url: prUrl,
      isPrimary: true, status: "ready_for_review", metadata: { source: "jules", headSha: head } };
    const children: Record<string, unknown>[] = [];
    const approvals: Record<string, unknown>[] = [];
    const runs: Record<string, unknown>[] = [];
    const repairProducts: Record<string, unknown>[] = [];
    const commands: Array<{ path: string; body: Record<string, unknown> }> = [];
    let loseCreateResponse = false;
    globalThis.fetch = async (url, init) => {
      const path = new URL(String(url)).pathname.replace(/^\/api/, "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (method !== "GET") commands.push({ path, body });
      let data: unknown;
      if (path === "/issues/source/work-products") data = [product];
      else if (path === "/work-products/product" && method === "PATCH") { product = { ...product, ...body }; data = product; }
      else if (path === "/agents/chosen") data = { id: "chosen", companyId: "company", adapterType, status: "idle" };
      else if (path === "/companies/company/agents") data = [{ id: "chosen", companyId: "company", adapterType, status: "idle" }];
      else if (path === "/issues/source/children" && method === "POST") {
        const child = { ...body, id: "repair", parentId: "source", companyId: "company", createdByAgentId: null };
        children.push(child);
        if (loseCreateResponse) { loseCreateResponse = false; throw new Error("response lost after admission"); }
        data = child;
      } else if (path === "/companies/company/issues") data = children;
      else if (path === "/companies/company/approvals" && method === "POST") {
        const card = { ...body, id: "manual-card", status: "pending" }; approvals.push(card); data = card;
      } else if (path === "/companies/company/approvals") data = approvals;
      else if (path === "/approvals/manual-card/reject") {
        Object.assign(approvals[0]!, { status: "rejected" }); data = approvals[0];
      }
      else if (path === "/issues/repair") data = children[0];
      else if (path === "/issues/repair/runs") data = runs;
      else if (path === "/issues/repair/work-products") data = repairProducts;
      else if (path === "/issues/source" && method === "PATCH") data = { id: "source", companyId: "company", ...body };
      else throw new Error(`Unexpected ${method} ${path}`);
      return new Response(JSON.stringify(data), { status: method === "POST" ? 201 : 200 });
    };
    const client = createPaperclipHttp({ apiUrl: "https://paperclip.test", authToken: "unit-token", runId: "orchestrator" });
    return { client, commands, children, approvals, get product() { return product; },
      loseResponse() { loseCreateResponse = true; },
      finishRepair() {
        Object.assign(children[0]!, { status: "done" });
        runs.push({ id: "repair-run", companyId: "company", agentId: "chosen", status: "succeeded",
          contextSnapshot: { issueId: "repair" }, resultJson: { provider: adapterType,
            ...(adapterType === "jules" ? { julesState: "COMPLETED", stopReason: "completed" } : {}) } });
        repairProducts.push({ id: "repair-output", type: "pull_request", url: prUrl,
          createdByRunId: "repair-run", metadata: { headSha: "c".repeat(40) } });
      } };
  }

  const input = (client: ReturnType<typeof createPaperclipHttp>, policy: recovery.ConflictRecoveryPolicy) => ({
    client, policy, companyId: "company", projectId: "project", issueId: "source", productId: "product",
    prUrl, headSha: head, mergeability: { prNumber: 1, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY",
      headRefName: "feature", baseRefName: "main", headRefOid: head, baseRefOid: base },
  });

  it("retains one native manual wait across ticks without admitting a repair", async () => {
    const f = fixture();
    const reconcile = (recovery as unknown as { reconcileConflictRecovery: (value: ReturnType<typeof input>) => Promise<unknown> }).reconcileConflictRecovery;
    for (let tick = 0; tick < 3; tick++) await reconcile(input(f.client, { mode: "manual" }));
    expect(f.children).toHaveLength(0);
    expect(f.approvals).toHaveLength(1);
    expect(f.approvals[0]).toMatchObject({ payload: { action: "conflict_resolution", issueId: "source", prUrl } });
  });

  it.each(["process", "codex_local", "antigravity", "jules"])("addresses exactly the configured independent %s agent", async (adapterType) => {
    const f = fixture(adapterType);
    const reconcile = (recovery as unknown as { reconcileConflictRecovery: (value: ReturnType<typeof input>) => Promise<unknown> }).reconcileConflictRecovery;
    await reconcile(input(f.client, { mode: "agent", agentId: "chosen" }));
    await reconcile(input(f.client, { mode: "agent", agentId: "chosen" }));
    expect(f.children).toHaveLength(1);
    expect(f.children[0]).toMatchObject({ assigneeAgentId: "chosen", status: "todo", blockParentUntilDone: false });
    expect(String(f.children[0]?.["description"])).toContain(prUrl);
    expect(String(f.children[0]?.["description"])).toContain("feature");
    expect(f.commands.filter((command) => command.path.startsWith("/agents/"))).toHaveLength(0);
  });

  it("observes accepted admission after response loss instead of creating another task", async () => {
    const f = fixture();
    const reconcile = (recovery as unknown as { reconcileConflictRecovery: (value: ReturnType<typeof input>) => Promise<unknown> }).reconcileConflictRecovery;
    f.loseResponse();
    await expect(reconcile(input(f.client, { mode: "agent", agentId: "chosen" }))).rejects.toThrow();
    await reconcile(input(f.client, { mode: "agent", agentId: "chosen" }));
    expect(f.children).toHaveLength(1);
  });

  it.each(["manual", "agent"] as const)("registers verified %s resolution separately from the original review head", async (mode) => {
    const f = fixture();
    const policy: recovery.ConflictRecoveryPolicy = mode === "agent" ? { mode, agentId: "chosen" } : { mode };
    await recovery.reconcileConflictRecovery(input(f.client, policy));
    if (mode === "agent") f.finishRepair();
    const resolvedHead = "c".repeat(40);
    const before = input(f.client, policy);
    const result = await recovery.reconcileConflictRecovery({ ...before, headSha: resolvedHead,
      mergeability: { ...before.mergeability, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: resolvedHead } });
    expect(result.kind).toBe("clear");
    expect(f.product["metadata"]).toMatchObject({ headSha: resolvedHead,
      conflictRecovery: { phase: "resolved", previousHeadSha: head, reviewHeadSha: head,
        resolvedHeadSha: resolvedHead, repairRunId: mode === "agent" ? "repair-run" : null } });
    expect(f.commands.some((command) => command.path.includes("/interactions"))).toBe(false);
    if (mode === "manual") expect(f.approvals[0]?.["status"]).toBe("rejected");
  });

  it("starts a new conflict epoch for an unrelated later revision without borrowing old reviews", async () => {
    const f = fixture();
    const policy = { mode: "manual" } as const;
    const before = input(f.client, policy);
    await recovery.reconcileConflictRecovery(before);
    await recovery.reconcileConflictRecovery({ ...before, headSha: "c".repeat(40),
      mergeability: { ...before.mergeability, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" } });
    await recovery.reconcileConflictRecovery({ ...before, headSha: "d".repeat(40) });
    expect(f.product["metadata"]).toMatchObject({ conflictRecovery: {
      previousHeadSha: "d".repeat(40), reviewHeadSha: "d".repeat(40), phase: "waiting" } });
    expect(f.approvals).toHaveLength(2);
  });
});
