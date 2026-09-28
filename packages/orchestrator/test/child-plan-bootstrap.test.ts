import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { childPlanReviewDescription } from "@pilleo/paperclip-adapter-common";
import { executeChildPlanBootstrap, classifyUnavailableReviewer } from "../src/core/child-plan-bootstrap.js";
import * as bootstrap from "../src/core/child-plan-bootstrap.js";
import { executeAllProjects } from "../src/server/execute.js";

describe("orchestrator child-plan bootstrap boundary", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it("recognizes only the exact host refusal for its paused addressed reviewer", () => {
    const body = { error: "addresseeAgentId must reference an invokable agent", details: { reason: "paused", agentId: "gemini" } };
    expect(classifyUnavailableReviewer(422, body, "gemini")?.reviewerId).toBe("gemini");
    expect(classifyUnavailableReviewer(422, body, "other")).toBeNull();
    expect(classifyUnavailableReviewer(403, body, "gemini")).toBeNull();
    expect(classifyUnavailableReviewer(422, { ...body, details: { reason: "policy_denied", agentId: "gemini" } }, "gemini")).toBeNull();
  });
  it("routes a child bootstrap even when its authoritative run also includes project scope", async () => {
    const boot = vi.spyOn(bootstrap, "executeChildPlanBootstrap").mockResolvedValue({ childId: "child", cardId: "card" });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const body = url.includes("heartbeat-runs") ? { id: "run", agentId: "orch", contextSnapshot: { projectId: "project", issueId: "child" } }
        : url.endsWith("/issues/child") ? { id: "child", projectId: "project", description: "child descriptor" }
        : url.endsWith("/projects") ? [] : null;
      if (body === null) throw new Error(`Unexpected request ${url}`);
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    const result = await executeAllProjects({ agent: { id: "orch", companyId: "co" }, runId: "run", authToken: "token",
      config: { apiUrl: "http://127.0.0.1:3100" }, context: { projectId: "project", issueId: "child" }, onLog: vi.fn(),
    } as unknown as AdapterExecutionContext);
    expect(boot).toHaveBeenCalledWith(expect.objectContaining({ issueId: "child", runId: "run", agentId: "orch" }));
    expect(result.resultJson).toMatchObject({ childPlanReviewBootstrap: { childId: "child", cardId: "card" } });
  });
  it("reports a parked child as unavailable rather than claiming a card was created", async () => {
    vi.spyOn(bootstrap, "executeChildPlanBootstrap").mockResolvedValue({ kind: "reviewer_unavailable", childId: "child", reviewerId: "gemini" });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes("heartbeat-runs") ? { id: "run", agentId: "orch", contextSnapshot: { issueId: "child" } }
        : { id: "child", description: "child descriptor" },
    ))));
    const result = await executeAllProjects({ agent: { id: "orch", companyId: "co" }, runId: "run", authToken: "token",
      config: { apiUrl: "http://127.0.0.1:3100" }, context: { issueId: "child" }, onLog: vi.fn(),
    } as unknown as AdapterExecutionContext);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toMatch(/unavailable/);
    expect(result.resultJson).toMatchObject({ childPlanReviewBootstrap: { kind: "reviewer_unavailable", childId: "child" } });
  });
  it("leaves ordinary issue execution to the existing scheduler", async () => {
    expect(await executeChildPlanBootstrap({ apiBase: "http://127.0.0.1:1", issueId: "ordinary", agentId: "orchestrator",
      runId: "run", token: "token", description: "Normal issue" })).toBeNull();
  });
  it("refuses to bootstrap with a different agent identity", async () => {
    const description = childPlanReviewDescription({ version: 3, companyId: "company", parentIssueId: "parent", sessionId: "session",
      activityId: "activity", documentId: "doc", revisionId: "revision", revisionNumber: 1, stage: "luna",
      bootstrapAgentId: "orchestrator", julesAgentId: "jules", reviewerAgentId: "luna" });
    await expect(executeChildPlanBootstrap({ apiBase: "http://127.0.0.1:1", issueId: "child", agentId: "luna",
      runId: "run", token: "token", description })).rejects.toThrow(/bootstrap/);
  });
});
