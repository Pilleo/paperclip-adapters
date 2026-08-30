import { describe, it, expect, vi } from "vitest";
import { initializeOrResumeSession, persistSessionBestEffort } from "../src/server/session-initializer.js";
import { JulesClient } from "../src/server/jules-client.js";
import { AdapterConfig } from "../src/server/config.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

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
});
