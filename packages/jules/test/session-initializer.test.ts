import { describe, it, expect, vi } from "vitest";
import { initializeOrResumeSession, persistSessionBestEffort } from "../src/server/session-initializer.js";
import { JulesClient } from "../src/server/jules-client.js";
import { AdapterConfig } from "../src/server/config.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { loadStoredSession } from "../src/server/session-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../src/server/paperclip-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/paperclip-client.js")>();
  return { ...actual, postSessionLink: vi.fn().mockResolvedValue(undefined),
    upsertJulesSessionHandle: vi.fn().mockResolvedValue(undefined) };
});

describe("session-initializer", () => {
  it("initializes a fresh session on first run", async () => {
    const client = {
      createSession: vi.fn().mockResolvedValue({
        id: "sess-created-1",
        url: "https://jules.example/sess-created-1",
        state: "IN_PROGRESS",
      }),
    } as unknown as JulesClient;

    const config: AdapterConfig = {
      source: "sources/github/example/repo",
      repository: "example/repo",
      baseBranch: "main",
      requirePlanApproval: false,
    };

    const ctx = {
      runId: "run-1",
      authToken: "token",
      onLog: vi.fn().mockResolvedValue(undefined),
    } as unknown as AdapterExecutionContext;

    const res = await initializeOrResumeSession(
      client,
      config,
      null,
      "issue-1",
      "Task Title",
      "Task Description",
      ctx
    );

    expect(res.createdSessionThisRun).toBe(true);
    expect(res.session.julesSessionId).toBe("sess-created-1");
    expect(res.session.phase).toBe("RUNNING");
  });

  it("forwards a required approval flag on its standalone creation path", async () => {
    const client = { createSession: vi.fn().mockResolvedValue({ id: "sess-required", state: "QUEUED" }) } as unknown as JulesClient;
    const config = { source: "sources/github/example/repo", repository: "example/repo", baseBranch: "main",
      requirePlanApproval: true, automationMode: "AUTO_CREATE_PR" } as AdapterConfig;
    const ctx = { runId: "run-required", onLog: vi.fn().mockResolvedValue(undefined) } as unknown as AdapterExecutionContext;
    await initializeOrResumeSession(client, config, null, "issue-required", "Implement", "Add a test", ctx);
    expect(client.createSession).toHaveBeenCalledWith(expect.objectContaining({ requirePlanApproval: true, automationMode: "AUTO_CREATE_PR" }), expect.any(String));
  });

  it("persists a prepared create intent before the standalone provider POST", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jules-init-intent-"));
    const original = process.env.PAPERCLIP_JULES_SESSION_STORE_DIR;
    process.env.PAPERCLIP_JULES_SESSION_STORE_DIR = directory;
    try {
      const client = { createSession: vi.fn(async () => {
        const checkpoint = await loadStoredSession("issue-1", "sources/github/example/repo", "main");
        expect(checkpoint).toMatchObject({ phase: "STARTING", providerCreateIntent: {
          source: "sources/github/example/repo", baseBranch: "main", runId: "run-1",
          promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        } });
        return { id: "session-1", state: "QUEUED" };
      }) } as unknown as JulesClient;
      await initializeOrResumeSession(client, { source: "sources/github/example/repo", repository: "example/repo",
        baseBranch: "main", requirePlanApproval: true } as AdapterConfig, null, "issue-1", "Task", "Task details",
      { runId: "run-1", onLog: vi.fn().mockResolvedValue(undefined) } as unknown as AdapterExecutionContext);
      expect(client.createSession).toHaveBeenCalledTimes(1);
    } finally {
      if (original === undefined) delete process.env.PAPERCLIP_JULES_SESSION_STORE_DIR;
      else process.env.PAPERCLIP_JULES_SESSION_STORE_DIR = original;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
