import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qualifyPlanApprovalStep } from "../scripts/qualify-plan-approval.js";

const request = { title: "Approval qualification", prompt: "Disposable approval boundary prompt",
  sourceContext: { source: "sources/github/Pilleo/disposable", githubRepoContext: { startingBranch: "master" } },
  requirePlanApproval: true, automationMode: "AUTO_CREATE_PR" };

describe("bounded Jules approval qualification", () => {
  it("observes an existing manifest without creating a second session or persisting the prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jules-approval-proof-"));
    try {
      const manifest = join(dir, "manifest.json");
      const client = { createSession: vi.fn().mockResolvedValue({ id: "session-1" }),
        listSessions: vi.fn(), getSession: vi.fn().mockResolvedValue({ id: "session-1", state: "AWAITING_PLAN_APPROVAL", updateTime: "2026-09-27T01:00:00Z", outputs: [] }),
        getActivities: vi.fn().mockResolvedValue({ activities: [{ id: "activity-1", createTime: "2026-09-27T01:00:00Z",
          planGenerated: { plan: { steps: [{ title: "secret text" }] } } }] }),
      };
      await qualifyPlanApprovalStep({ client, manifestPath: manifest, request, createAllowed: true });
      await qualifyPlanApprovalStep({ client, manifestPath: manifest, request, createAllowed: true });
      expect(client.createSession).toHaveBeenCalledTimes(1);
      const saved = await readFile(manifest, "utf8");
      expect(saved).not.toContain(request.prompt);
      expect(saved).not.toContain("secret text");
      expect(JSON.parse(saved).sessionId).toBe("session-1");
      expect((await stat(manifest)).mode & 0o077).toBe(0);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("never replays a lost create response when provider discovery finds nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jules-approval-ambiguous-"));
    try {
      const manifest = join(dir, "manifest.json");
      const client = { createSession: vi.fn().mockRejectedValueOnce(new Error("lost response")),
        listSessions: vi.fn().mockResolvedValue({ sessions: [] }), getSession: vi.fn(), getActivities: vi.fn() };
      await expect(qualifyPlanApprovalStep({ client, manifestPath: manifest, request, createAllowed: true })).rejects.toThrow(/outcome unknown/);
      await expect(qualifyPlanApprovalStep({ client, manifestPath: manifest, request, createAllowed: true })).rejects.toThrow(/not uniquely identified/);
      expect(client.createSession).toHaveBeenCalledTimes(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
