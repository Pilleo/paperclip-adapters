import { afterEach, describe, expect, it, vi } from "vitest";
import { JulesClient } from "../src/server/jules-client.js";
import { createProviderCreateEvidence } from "../src/server/provider-request-evidence.js";

const request = {
  title: "Disposable increment task",
  prompt: "Implement increment(2) returns 3; test with node --test. Paperclip Issue ID: issue-1",
  sourceContext: { source: "sources/github/Pilleo/disposable", githubRepoContext: { startingBranch: "master" } },
  requirePlanApproval: true,
  automationMode: "AUTO_CREATE_PR",
};

describe("Jules provider request evidence", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it("builds allowlisted create evidence without exposing the prompt or API key", () => {
    const evidence = createProviderCreateEvidence(request, { issueId: "issue-1", runId: "run-1" });
    expect(evidence).toMatchObject({ kind: "create", issueId: "issue-1", runId: "run-1",
      requirePlanApproval: true, automationMode: "AUTO_CREATE_PR", source: "sources/github/Pilleo/disposable",
      baseBranch: "master", promptSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(evidence)).not.toContain("Implement increment");
    expect(JSON.stringify(evidence)).not.toContain("secret-key");
  });

  it("records the exact serialized approval flag before provider POST", async () => {
    const steps: string[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      steps.push("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({ requirePlanApproval: true, automationMode: "AUTO_CREATE_PR" });
      return { ok: true, status: 200, json: async () => ({ name: "sessions/123", state: "QUEUED" }) } as Response;
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const client = new JulesClient("secret-key", undefined, "https://jules.googleapis.com/v1alpha", {
      issueId: "issue-1", runId: "run-1", onEvidence: async (evidence) => {
        steps.push("evidence");
        expect(JSON.stringify(evidence)).not.toContain("secret-key");
        expect(JSON.stringify(evidence)).not.toContain(request.prompt);
      },
    });
    await client.createSession(request);
    expect(steps).toEqual(["evidence", "POST"]);
  });

  it("records the plan identity before an approval mutation without exposing provider credentials", async () => {
    const steps: string[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      steps.push("POST");
      expect(init?.method).toBe("POST");
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as typeof fetch;
    const client = new JulesClient("secret-key", undefined, "https://jules.googleapis.com/v1alpha", {
      issueId: "issue-1", runId: "run-1", onEvidence: async (evidence) => {
        steps.push("evidence");
        expect(evidence).toMatchObject({ kind: "mutation", method: "approve_plan", effectId: "approve:session-1:rev-1",
          planActivityId: "plan-activity-1", sessionId: "session-1" });
        expect(JSON.stringify(evidence)).not.toContain("secret-key");
      },
    });
    await client.approvePlan("session-1" as never, { effectId: "approve:session-1:rev-1", planActivityId: "plan-activity-1" });
    expect(steps).toEqual(["evidence", "POST"]);
  });
});
