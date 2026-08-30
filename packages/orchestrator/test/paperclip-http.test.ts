import { describe, it, expect, vi, afterEach } from "vitest";
import { createPaperclipHttp } from "../src/core/paperclip-http.js";

describe("createPaperclipHttp wakeup", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("puts issueId in payload, not at the top level", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const pc = createPaperclipHttp({
      apiUrl: "http://127.0.0.1:3100",
      authToken: "test-token",
      runId: "run-1",
    });
    const result = await pc.wakeup("agent-jules", "reattach after process-lost", "issue-821");
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      source: "on_demand",
      triggerDetail: "ping",
      reason: "reattach after process-lost",
      forceFreshSession: false,
      payload: { issueId: "issue-821" },
    });
    expect(body.issueId).toBeUndefined();
  });
});
